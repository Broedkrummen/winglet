"""One narrow adapter over the installed gateway's real context/compress paths."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
from datetime import datetime, timezone

from .branching import HermesBranchBridge, BranchRefused, transcript_revision
from .execution import redact


def number(value):
    return float(value) if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0 else None


class ContextBridge:
    def __init__(self, adapter):
        self.adapter=adapter
        self.sessions=HermesBranchBridge(adapter)

    @property
    def runner(self): return getattr(self.adapter,'gateway_runner',None)

    def capabilities(self):
        runner=self.runner
        reads=self.sessions.available() and all(callable(getattr(runner,name,None)) for name in
            ('_resident_agent_for','_async_profile_scope_for_source','_session_context_breakdown'))
        compression=reads and all(callable(getattr(runner,name,None)) for name in
            ('_handle_compress_command','_async_profile_scope_for_source','_is_session_running')) and getattr(runner,'_turn_leases',None) is not None
        limits=reads and callable(getattr(runner,'_resolve_session_agent_runtime',None)) and callable(getattr(runner,'_async_profile_scope_for_source',None))
        return {'session_context':reads,'context_compression':compression,'usage_insights':reads,'provider_limits':limits}

    async def snapshot(self, chat, device):
        snap=await self.sessions.snapshot(chat['id'])
        route_signature=None
        if callable(getattr(self.runner,'_resolve_session_agent_runtime',None)):
            source=self.sessions.source_for(chat,device)
            async with self.runner._async_profile_scope_for_source(source):
                model,kwargs=await asyncio.to_thread(self.runner._resolve_session_agent_runtime,source=source,session_key=snap.session_key)
            snap.model={'model':str(model or ''),'provider':str(kwargs.get('provider') or ''),'source':'resolved'}
            route_signature=(snap.model,kwargs.get('base_url'),kwargs.get('api_mode'))
        content_revision=transcript_revision(self.adapter._hub.store.all_messages(chat['id']),snap.rows)
        revision='cx-'+hashlib.sha256(json.dumps([content_revision,snap.model,route_signature],sort_keys=True,default=str).encode()).hexdigest()
        return snap,revision

    async def inspect(self, chat, device):
        from agent.model_metadata import estimate_messages_tokens_rough
        snap,revision=await self.snapshot(chat,device)
        source=self.sessions.source_for(chat,device)
        runner=self.runner
        agent=runner._resident_agent_for(snap.session_key)
        model=snap.model or {}
        used=number(estimate_messages_tokens_rough(snap.rows))
        payload={'context_used':used,'context_source':'local_estimate','context_max':None,
                 'categories':[{'id':'conversation','label':'Conversation','tokens':used}],
                 'estimated_total':used}
        # Reading the live agent mid-turn could race mutations and mix generations.
        # Only inspect a resident snapshot between turns, just as gateway /context.
        running=bool(runner._is_session_running(snap.session_key)) if callable(getattr(runner,'_is_session_running',None)) else False
        details={'skills':[],'toolsets':[]}
        rate_limits=[]
        compression_count=None
        if agent is not None and not running and (not model.get('model') or getattr(agent,'model','')==model['model']):
            try:
                async with runner._async_profile_scope_for_source(source):
                    payload=await asyncio.to_thread(runner._session_context_breakdown,agent,source)
                    from agent.context_breakdown import compute_context_details
                    expanded=await asyncio.to_thread(compute_context_details,agent)
                    details={'skills':[{'name':str(s.get('name') or '')[:100],'index_tokens':number(s.get('index_tokens')),'file_tokens':number(s.get('skill_md_tokens'))} for s in expanded.get('skills',[])[:64]],
                             'toolsets':[{'name':str(s.get('toolset') or '')[:100],'tokens':number(s.get('schema_tokens')),'tools':number(s.get('tool_count'))} for s in expanded.get('toolsets',[])[:64]]}
                    compression_count=number(getattr(getattr(agent,'context_compressor',None),'compression_count',None))
                    rate=getattr(agent,'get_rate_limit_state',lambda:None)()
                    if rate is not None and rate.has_data:
                        for key,label in (('requests_min','Requests / minute'),('requests_hour','Requests / hour'),('tokens_min','Tokens / minute'),('tokens_hour','Tokens / hour')):
                            bucket=getattr(rate,key,None)
                            if bucket is not None and number(bucket.limit):
                                rate_limits.append({'label':label,'limit':number(bucket.limit),'remaining':number(bucket.remaining),
                                                    'captured_at':number(bucket.captured_at),'resets_at':bucket.captured_at+bucket.reset_seconds})
            except Exception:
                # A partial view stays explicitly estimated; never synthesize a prompt.
                pass
        if not payload.get('context_max') and callable(getattr(runner,'_resolve_route_context',None)):
            with contextlib.suppress(Exception):
                route_model=model.get('model') or payload.get('model') or ''
                # Carry the session override's own endpoint into model metadata.
                route_kwargs=None
                if callable(getattr(runner,'_resolve_session_agent_runtime',None)):
                    async with runner._async_profile_scope_for_source(source):
                        _,route_kwargs=await asyncio.to_thread(runner._resolve_session_agent_runtime,source=source,session_key=snap.session_key)
                route=await runner._resolve_route_context(source,str(route_model),route_kwargs)
                if route is not None:
                    # Hermes has a probing fallback (currently256K). It is not
                    # an observed/configured model limit and must stay unknown.
                    payload={**payload,'context_max':number(getattr(route,'context_length',None)) if getattr(route,'context_source','default')!='default' else None,
                             'model':getattr(route,'model','')}
        db=self.sessions._db_for_session(snap.session_id)
        row=await asyncio.to_thread(db.get_session,snap.session_id) if db is not None else {}
        row=row or {}
        usage={name:number(row.get(name)) for name in ('input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','api_call_count')}
        # Session DB cost provenance is retained; missing/default zeros are unknown.
        cost_status=str(row.get('cost_status') or '')
        actual=number(row.get('actual_cost_usd'))
        estimate=number(row.get('estimated_cost_usd'))
        measured=actual is not None and cost_status=='actual'
        estimated=estimate is not None and (estimate>0 or cost_status=='estimated')
        usage['cost']={'currency':'USD','value':actual if measured else estimate if estimated else None,
                       'source':'measured' if measured else 'estimated' if estimated else 'unavailable'}
        breakdown=[{'id':str(c.get('id',''))[:64],'label':str(c.get('label',''))[:80],'tokens':number(c.get('tokens'))} for c in payload.get('categories',[])[:20]]
        window=number(payload.get('context_max'))
        result={'chat_id':chat['id'],'revision':revision,'session_id':snap.session_id,
                'model':str(model.get('model') or payload.get('model') or row.get('model') or '')[:200],
                'provider':str(model.get('provider') or '')[:100],
                'context':{'used':number(payload.get('context_used')),'window':window if window else None,
                           'source':str(payload.get('context_source') or 'local_estimate'),
                           'categories':breakdown,'estimated_total':number(payload.get('estimated_total'))},
                'usage':usage,'details':details,'rate_limits':rate_limits,'compression_count':compression_count,
                'busy':running,'sampled_at':datetime.now(timezone.utc).timestamp(),
                'warning':'Category sizes are estimates; session throughput is cumulative, not current context.'}
        # A turn/model change during async work invalidates every number in this view.
        fresh,latest=await self.snapshot(chat,device)
        if latest!=revision or fresh.model!=snap.model:
            raise BranchRefused('stale','The chat changed while context was loading. Refresh it.')
        return result

    async def account_route(self,chat,device):
        source=self.sessions.source_for(chat,device)
        async with self.runner._async_profile_scope_for_source(source):
            model,kwargs=await asyncio.to_thread(self.runner._resolve_session_agent_runtime,source=source,session_key=self.sessions.key_for(chat['id']))
        # Only this local private mapping carries secrets; never serialize/log it.
        provider=kwargs.get('provider') or kwargs.get('requested_provider') or ''
        identity=hashlib.sha256(repr((chat.get('bot'),provider,kwargs.get('base_url'),kwargs.get('api_key'))).encode()).hexdigest()
        return identity,provider,kwargs,source

    async def account(self,route):
        from agent.account_usage import fetch_account_usage
        _,provider,kwargs,source=route
        async with self.runner._async_profile_scope_for_source(source):
            snapshot=await asyncio.to_thread(fetch_account_usage,provider,base_url=kwargs.get('base_url'),api_key=kwargs.get('api_key'))
        if snapshot is None:
            return {'available':False,'provider':provider,'reason':'This provider did not supply account limits.','windows':[],'details':[]}
        # Whitelist normalized fields. In particular snapshot.raw is never exposed.
        return {'available':bool(snapshot.available),'provider':str(snapshot.provider)[:100],
                'kind':'credits' if provider in ('openrouter','nous') else 'account_windows',
                'fetched_at':snapshot.fetched_at.timestamp(),'source':str(snapshot.source)[:100],
                'windows':[{'label':redact(w.label,100),'used_percent':min(100,number(w.used_percent)) if number(w.used_percent) is not None else None,
                            'resets_at':w.reset_at.timestamp() if w.reset_at else None,'detail':redact(w.detail or '',200)} for w in snapshot.windows[:12]],
                'details':[redact(line,200) for line in snapshot.details[:12]],
                'reason':redact(snapshot.unavailable_reason or '',200)}

    async def compress(self,chat,device,expected,check):
        from gateway.platforms.base import MessageEvent,MessageType
        runner=self.runner
        source=self.sessions.source_for(chat,device)
        snap,revision=await self.snapshot(chat,device)
        if expected!=revision: raise BranchRefused('stale','The context preview is stale. Refresh it.')
        lease=await runner._turn_leases.acquire(snap.session_id,owner_key='winglet-context:'+chat['id'],generation=1,timeout=.2)
        try:
            # Lease acquisition yielded; recheck authority, revision, and runtime.
            check()
            _,fresh=await self.snapshot(chat,device)
            if fresh!=expected or runner._is_session_running(snap.session_key):
                raise BranchRefused('busy','The chat changed or started a reply. Wait and refresh.')
            before=await self.inspect(chat,device)
            event=MessageEvent(text='/compress',message_type=MessageType.COMMAND,source=source,
                               timestamp=datetime.now(timezone.utc))
            async with runner._async_profile_scope_for_source(source):
                note=await runner._handle_compress_command(event)
            after=await self.inspect(chat,device)
            runner._turn_leases.rebind(lease,after['session_id'])
            changed=before['revision']!=after['revision'] or (after['compression_count'] is not None and before['compression_count'] is not None and after['compression_count']>before['compression_count'])
            return {'status':'completed' if changed else 'unchanged','changed':changed,
                    'before':before['context'],'after':after['context'],
                    'revision':after['revision'],'previous_revision':before['revision'],
                    'outcome':redact(str(note or 'Hermes returned no outcome.'),1200)}
        finally:
            runner._turn_leases.release(lease)
