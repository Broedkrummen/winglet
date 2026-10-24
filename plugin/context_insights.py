"""Scoped numeric context views and retained, non-replayed compression operations."""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import time
from pathlib import Path

from .branching import BranchRefused
from .context_insights_hermes import ContextBridge

OPERATION=re.compile(r'^[A-Za-z0-9._:-]{16,96}$')


class ContextInsights:
    def __init__(self,hub,adapter,bridge=None):
        self.hub=hub
        self.bridge=bridge or ContextBridge(adapter)
        self.path=Path(hub.store.path).with_name('context-operations.sqlite')
        self.tasks={}
        self.accounts={}
        self.cache={}
        self._closing=False
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS winglet_context_ops (id TEXT PRIMARY KEY, device TEXT NOT NULL, chat TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL, created REAL NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS winglet_context_ops_scope ON winglet_context_ops(device,chat,created)')
            db.execute("UPDATE winglet_context_ops SET state='unknown',result=? WHERE state='running'",
                       (json.dumps({'status':'unknown','outcome':'Gateway restarted before a final receipt. Refresh context; this request will not run again.'}),))

    def db(self):
        db=sqlite3.connect(self.path,timeout=10)
        db.row_factory=sqlite3.Row
        return db

    def capabilities(self): return self.bridge.capabilities()

    def actor(self,device,chat):
        fresh=self.hub.store.get_device(device['id'])
        current=self.hub.store.get_chat(chat['id'])
        if fresh is None or fresh.get('role')!='owner':
            raise BranchRefused('forbidden','An owner can inspect context and provider usage.',403)
        if current is None or current.get('bot')!=chat.get('bot') or not self.hub.can_see(fresh,current):
            raise BranchRefused('not_found','This chat is no longer available.',404)
        return fresh,current

    def busy(self,chat_id): return any(chat_id==chat for chat,_ in self.tasks.values())

    async def inspect(self,device,chat):
        device,chat=self.actor(device,chat)
        if not self.capabilities()['session_context']:
            raise BranchRefused('unsupported','This Hermes cannot inspect session context.',409)
        result=await self.bridge.inspect(chat,device)
        self.actor(device,chat)
        result['busy']=bool(result['busy'] or self.busy(chat['id']) or (self.hub.branching and self.hub.branching.busy(chat['id'])))
        result['can_compress']=self.capabilities()['context_compression'] and not result['busy']
        with self.db() as db:
            last=db.execute('SELECT id FROM winglet_context_ops WHERE device=? AND chat=? ORDER BY created DESC LIMIT 1',(device['id'],chat['id'])).fetchone()
        result['last_operation']=self.operation(device,chat,last['id']) if last else None
        return result

    async def limits(self,device,chat):
        device,chat=self.actor(device,chat)
        if not self.capabilities()['provider_limits']:
            raise BranchRefused('unsupported','Provider account telemetry is unavailable.',409)
        route=await self.bridge.account_route(chat,device)
        identity=route[0]
        cached=self.cache.get(identity)
        if cached and time.time()-cached[0]<60:
            self.actor(device,chat)
            return {**cached[1],'cached':True,'age_seconds':max(0,time.time()-cached[0])}
        task=self.accounts.get(identity)
        if task is None:
            if len(self.accounts)>=8:raise BranchRefused('busy','Account telemetry is busy. Try again shortly.',429)
            async def fetch():
                try:
                    value=await self.bridge.account(route)
                    if len(self.cache)>=64:self.cache.pop(next(iter(self.cache)))
                    self.cache[identity]=(time.time(),value)
                    return value
                except Exception:
                    value={'available':False,'provider':route[1],'reason':'The provider account query failed. Try again later.','windows':[],'details':[]}
                    self.cache[identity]=(time.time(),value)
                    return value
                finally:self.accounts.pop(identity,None)
            task=self.accounts[identity]=asyncio.create_task(fetch())
        try:
            value=await asyncio.wait_for(asyncio.shield(task),timeout=7)
        except asyncio.TimeoutError:
            self.actor(device,chat)
            return {'available':False,'pending':True,'provider':route[1],'reason':'The account query is still running. Refresh in a moment.','windows':[],'details':[]}
        self.actor(device,chat)
        # A model switch can select a different account while the request runs.
        latest=await self.bridge.account_route(chat,device)
        if latest[0]!=identity:raise BranchRefused('stale','The provider changed. Refresh account limits.')
        return {**value,'cached':False,'age_seconds':0}

    def operation(self,device,chat,operation_id):
        self.actor(device,chat)
        with self.db() as db:
            row=db.execute('SELECT * FROM winglet_context_ops WHERE id=?',(operation_id,)).fetchone()
        if row is None or row['device']!=device['id'] or row['chat']!=chat['id']:
            raise BranchRefused('not_found','That context operation is not available.',404)
        if row['state']=='running' and operation_id not in self.tasks:
            return {'operation_id':operation_id,'status':'unknown','outcome':'The worker has no final receipt. Refresh context; this request will not run again.'}
        return {'operation_id':operation_id,**json.loads(row['result']),'status':row['state']}

    async def start(self,device,chat,body):
        device,chat=self.actor(device,chat)
        if self._closing or not self.capabilities()['context_compression']:
            raise BranchRefused('unsupported','Context compression is unavailable.',409)
        operation_id=body.get('operation_id')
        revision=body.get('revision')
        if not isinstance(operation_id,str) or not OPERATION.fullmatch(operation_id) or not isinstance(revision,str) or not revision:
            raise BranchRefused('invalid','Refresh the preview and provide a stable operation ID.',400)
        with self.db() as db:
            old=db.execute('SELECT * FROM winglet_context_ops WHERE id=?',(operation_id,)).fetchone()
        if old:
            if old['device']!=device['id'] or old['chat']!=chat['id'] or old['revision']!=revision:
                raise BranchRefused('conflict','That operation ID belongs to another request.')
            return self.operation(device,chat,operation_id)
        preview=await self.inspect(device,chat)
        if preview['busy']:raise BranchRefused('busy','Wait for the current reply or context action to finish.')
        if preview['revision']!=revision:raise BranchRefused('stale','This context preview is stale. Refresh it.')
        if len(self.tasks)>=8:raise BranchRefused('busy','Too many context actions are running. Try again later.',429)
        # Serialize with branching. No await between the final busy test, receipt
        # insertion and task publication, so a second request cannot slip through.
        lock=self.hub.branching._lock(chat['id'])
        if lock.locked() or self.busy(chat['id']):raise BranchRefused('busy','This chat is busy.')
        with self.db() as db:
            if db.execute('SELECT count(*) FROM winglet_context_ops').fetchone()[0]>=100000:
                raise BranchRefused('full','Context operation history reached its limit. Ask the server owner to review it.',507)
            db.execute('INSERT INTO winglet_context_ops VALUES(?,?,?,?,?,?,?)',
                       (operation_id,device['id'],chat['id'],revision,'running',json.dumps({'status':'running','outcome':'Hermes is processing this context request.'}),time.time()))
        async def run():
            try:
                async with lock:
                    result=await self.bridge.compress(chat,device,revision,lambda:self.actor(device,chat))
            except BranchRefused as exc:
                result={'status':'refused','outcome':exc.reason}
            except Exception:
                # A provider failure may have partially changed the model context.
                # Never rerun it automatically or claim the original is unchanged.
                result={'status':'unknown','outcome':'Hermes did not return a complete result. Refresh context before another action.'}
            with self.db() as db:
                db.execute('UPDATE winglet_context_ops SET state=?,result=? WHERE id=?',(result['status'],json.dumps(result),operation_id))
            self.tasks.pop(operation_id,None)
            self.hub.audit('context.compress',device,summary=f"Chat {chat['id']}: {result['status']}")
            await self.hub.broadcast({'type':'context.updated','chat_id':chat['id'],'operation_id':operation_id,'status':result['status']})
        task=asyncio.create_task(run())
        self.tasks[operation_id]=(chat['id'],task)
        def finished(done):
            self.tasks.pop(operation_id,None)
            # Observe exceptions after shutdown/storage failure. The retained
            # running receipt is exposed as unknown, never replayed as work.
            if not done.cancelled():done.exception()
        task.add_done_callback(finished)
        return self.operation(device,chat,operation_id)

    async def close(self):
        self._closing=True
        # Do not cancel an already accepted provider operation on client disconnect.
        jobs=[task for _,task in self.tasks.values()]+list(self.accounts.values())
        if jobs:await asyncio.wait(jobs,timeout=5)
