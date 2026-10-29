"""Versioned task templates. Parsing/rendering never executes tools or changes defaults."""
from __future__ import annotations

import math
import re

_TOKEN = re.compile(r'\{\{([a-z][a-z0-9_]{0,39})\}\}')
_NAME = re.compile(r'[a-z][a-z0-9_]{0,39}')


def _text(value, limit, label, *, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f'Invalid preset {label}.')
    return value


def _id(value):
    _text(value, 160, 'reference')
    if any(ord(character) < 32 for character in value):
        raise ValueError('Invalid preset reference.')


def _input_value(spec, value):
    kind = spec['type']
    if kind == 'text':
        _text(value, 8000, f'input {spec["name"]}', empty=not spec['required'])
    elif kind == 'number':
        if type(value) not in (int, float) or abs(value) > 9007199254740991 or not math.isfinite(value):
            raise ValueError(f'Input {spec["name"]} needs a finite safe number.')
    elif kind == 'boolean':
        if type(value) is not bool:
            raise ValueError(f'Input {spec["name"]} needs true or false.')
    elif value not in spec['choices']:
        raise ValueError(f'Choose an available value for {spec["name"]}.')


def validate_definition(value):
    required = {'version', 'name', 'template', 'inputs'}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {'model', 'reasoning', 'project', 'capabilities'}:
        raise ValueError('Invalid task preset definition.')
    _id(value['version'])
    _text(value['name'], 160, 'name')
    _text(value['template'], 32000, 'template')
    if not isinstance(value['inputs'], list) or len(value['inputs']) > 20:
        raise ValueError('A preset accepts at most 20 typed inputs.')
    names = set()
    for spec in value['inputs']:
        if not isinstance(spec, dict) or not {'name', 'label', 'type', 'required'} <= set(spec) \
                or set(spec) - {'name', 'label', 'type', 'required', 'default', 'choices'}:
            raise ValueError('Invalid preset input.')
        if not isinstance(spec['name'], str) or not _NAME.fullmatch(spec['name']) or spec['name'] in names:
            raise ValueError('Preset inputs need unique lowercase names.')
        names.add(spec['name'])
        _text(spec['label'], 160, 'input label')
        if spec['type'] not in ('text', 'number', 'boolean', 'choice') or type(spec['required']) is not bool:
            raise ValueError('Invalid preset input type or requirement.')
        if spec['type'] == 'choice':
            choices = spec.get('choices')
            if not isinstance(choices, list) or not 1 <= len(choices) <= 50:
                raise ValueError('Choice inputs need 1–50 choices.')
            for choice in choices:
                _text(choice, 160, 'choice')
            if len(set(choices)) != len(choices):
                raise ValueError('Preset choices must be distinct.')
        elif 'choices' in spec:
            raise ValueError('Only choice inputs accept choices.')
        if 'default' in spec:
            _input_value(spec, spec['default'])
    if set(_TOKEN.findall(value['template'])) - names or '{{' in _TOKEN.sub('', value['template']) or '}}' in _TOKEN.sub('', value['template']):
        raise ValueError('Use {{input_name}} placeholders declared in the preset inputs.')
    if 'model' in value:
        if not isinstance(value['model'], dict) or set(value['model']) != {'provider', 'model'}:
            raise ValueError('A preset model needs its exact provider and model identifier.')
        for part in value['model'].values():
            _id(part)
    if 'reasoning' in value:
        _id(value['reasoning'])
    if 'project' in value:
        if not isinstance(value['project'], dict) or set(value['project']) != {'server_id', 'server_fingerprint', 'project_id'}:
            raise ValueError('A preset project needs its exact source identity.')
        for part in value['project'].values():
            _id(part)
    if 'capabilities' in value:
        if not isinstance(value['capabilities'], list) or len(value['capabilities']) > 64:
            raise ValueError('A preset accepts at most 64 capability references.')
        for capability in value['capabilities']:
            _id(capability)
        if len(set(value['capabilities'])) != len(value['capabilities']):
            raise ValueError('Preset capabilities must be distinct.')
    return value


def render_preset(definition, inputs):
    validate_definition(definition)
    if not isinstance(inputs, dict) or set(inputs) - {spec['name'] for spec in definition['inputs']}:
        raise ValueError('Unexpected preset inputs.')
    values = {}
    for spec in definition['inputs']:
        name = spec['name']
        if name not in inputs and 'default' not in spec:
            if spec['required']:
                raise ValueError(f'Fill in {spec["label"]} before applying the preset.')
            values[name] = ''
            continue
        item = inputs[name] if name in inputs else spec['default']
        _input_value(spec, item)
        values[name] = ('true' if item else 'false') if type(item) is bool else str(item)
    text = _TOKEN.sub(lambda match: values[match[1]], definition['template'])
    if not text.strip():
        raise ValueError('The rendered preset is empty. Fill in an input before applying it.')
    if len(text) > 32000:
        raise ValueError('The rendered preset exceeds 32,000 characters. Shorten its inputs.')
    return text
