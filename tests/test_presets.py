"""Preset rendering is data processing, never execution or permission elevation."""
import copy

import pytest

from plugin.presets import render_preset, validate_definition


def definition():
    return {'version': 'version-one', 'name': 'Research a topic', 'template': 'Research {{topic}} in {{count}} steps; cite={{cite}}; format={{format}}.',
            'inputs': [{'name': 'topic', 'label': 'Topic', 'type': 'text', 'required': True},
                       {'name': 'count', 'label': 'Steps', 'type': 'number', 'required': True, 'default': 3},
                       {'name': 'cite', 'label': 'Cite sources', 'type': 'boolean', 'required': True, 'default': True},
                       {'name': 'format', 'label': 'Format', 'type': 'choice', 'required': True, 'choices': ['brief', 'table'], 'default': 'brief'}]}


def test_rendering_preserves_literal_user_input_and_applies_typed_defaults():
    preset = definition()
    original = copy.deepcopy(preset)
    assert render_preset(preset, {'topic': '$(do not execute) {{count}}'}) == 'Research $(do not execute) {{count}} in 3 steps; cite=true; format=brief.'
    assert preset == original
    assert render_preset(preset, {'topic': 'Winglet', 'count': 0, 'cite': False, 'format': 'table'}) == 'Research Winglet in 0 steps; cite=false; format=table.'


@pytest.mark.parametrize('inputs', [{}, {'topic': ''}, {'topic': 'x', 'count': True}, {'topic': 'x', 'count': float('inf')},
                                   {'topic': 'x', 'count': 10 ** 4000},
                                   {'topic': 'x', 'cite': 'false'}, {'topic': 'x', 'format': 'unknown'}, {'topic': 'x', 'extra': 'ignored'}])
def test_invalid_or_missing_inputs_do_not_produce_a_partial_prompt(inputs):
    with pytest.raises(ValueError):
        render_preset(definition(), inputs)


def test_definition_rejects_unknown_permissions_placeholders_and_ambiguous_inputs():
    for patch in ({'permissions': ['auto-approve']}, {'template': '{{missing}}'}, {'template': '{{ invalid }}'},
                  {'model': {'model': 'x', 'api_key': 'secret'}}, {'project': {'project_id': 'x', 'url': 'https://private'}}):
        with pytest.raises(ValueError):
            validate_definition({**definition(), **patch})
    preset = definition()
    preset['inputs'].append(copy.deepcopy(preset['inputs'][0]))
    with pytest.raises(ValueError, match='unique'):
        validate_definition(preset)


def test_rendered_size_is_bounded_after_expansion():
    preset = definition()
    preset['template'] = '{{topic}}' * 5
    with pytest.raises(ValueError, match='32,000'):
        render_preset(preset, {'topic': 'x' * 8000})
