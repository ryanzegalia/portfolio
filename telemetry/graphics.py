"""Bounded copies of gfxReport fields only; no additional device collection."""
import math

STRINGS = {'gpu': 500, 'webgl': 150, 'canvas': 50, 'buffer': 50, 'ua': 500, 'screen': 60, 'viewport': 50}
NUMBERS = {'maxTexture', 'lost', 'restored', 'frames', 'calls', 'triangles', 'dpr'}
EXTENSIONS = {'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'EXT_texture_filter_anisotropic'}


def clean_report(value):
    if not isinstance(value, dict):
        return {}
    result = {key: value[key][:limit] for key, limit in STRINGS.items() if isinstance(value.get(key), str)}
    for key in NUMBERS:
        number = value.get(key)
        if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number):
            result[key] = max(0, min(number, 1e12))
    if isinstance(value.get('contextLostNow'), bool):
        result['contextLostNow'] = value['contextLostNow']
    if isinstance(value.get('extensions'), dict):
        result['extensions'] = {key: val for key, val in value['extensions'].items() if key in EXTENSIONS and isinstance(val, bool)}
    for key in ('shaderErrors', 'errors'):
        if isinstance(value.get(key), list):
            result[key] = [item[:300] for item in value[key][:6] if isinstance(item, str)]
    return result


def summarize(reports):
    gpu = next((r.get('gpu') for r in reversed(reports) if r.get('gpu')), '')
    flags = []
    if any(r.get('lost', 0) or r.get('contextLostNow') for r in reports):
        flags.append('GPU context lost')
    if any(r.get('shaderErrors') for r in reports):
        flags.append('Shader error')
    # An otherwise healthy zero-frame report is the five-second baseline. Early
    # lost/shader snapshots are already flagged above, not called a timed baseline.
    if any(r.get('frames') == 0 and not (r.get('lost') or r.get('contextLostNow') or r.get('shaderErrors')) for r in reports):
        flags.append('No frames after 5 seconds')
    if any(r.get('triangles') == 0 for r in reports):
        flags.append('Zero triangles')
    return {'gpu': gpu, 'flags': flags, 'reports': reports}
