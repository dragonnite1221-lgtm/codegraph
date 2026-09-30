"""Validate recorded local review evidence; this never calls an AI service."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = '.github/review-evidence/windows-fixes.json'
def safe_path(name):
    return (isinstance(name, str) and bool(name) and not PurePosixPath(name).is_absolute()
            and '\\' not in name and ':' not in name
            and all(part not in ('', '.', '..') for part in name.split('/'))
            and not any(ord(char) < 32 or ord(char) == 127 for char in name))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def load(path):
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def model_key(model, family):
    prefix = 'gemini-' if family == 'gemini-flash' else 'claude-sonnet-'
    suffix = r'-flash(?:-(.*))?' if family == 'gemini-flash' else r'(?:-(.*))?'
    match = re.fullmatch(re.escape(prefix) + r'(\d+(?:[.-]\d+)*)' + suffix, model)
    if not match:
        return None
    version = tuple(int(n) for n in re.split(r'[.-]', match[1]))
    tier = {'high': 3, 'medium': 2, 'low': 1}.get(match[2], 0)
    return version, tier


def validate():
    if not __debug__:
        raise ValueError('Optimized Python disables assertions; validation refused')
    policy = load(ROOT / '.github/ai-review-policy.json')
    evidence = load(ROOT / EVIDENCE)
    family = policy['active_family']
    assert family in ('gemini-flash', 'claude-sonnet'), 'Unsupported reviewer family'
    assert evidence['provider'] == 'antigravity' and evidence['mechanism'] == 'local-cli'
    assert evidence['family'] == family, 'Review does not match active policy'
    requested = evidence['requested_model']
    assert evidence['confirmed_model'] == requested, 'Runtime model is unverified or substituted'
    available = [model for model in evidence['catalog_models'] if model_key(model, family) is not None]
    assert available and requested in available, 'Selected model is absent from recorded catalog'
    assert model_key(requested, family) == max(model_key(model, family) for model in available), 'Review did not select the newest available family model'
    if family == 'claude-sonnet':
        quota = evidence['quota_recovery']
        assert quota['status'] == 'recovered' and quota['mechanism'] == 'read-only-status'
        assert quota['observed_at_utc'] and quota['evidence_reference'], 'Missing quota-recovery evidence'
    head = evidence['reviewed_fix_head']
    baseline = evidence['baseline']
    expected_base = os.environ.get('EXPECTED_REVIEW_BASE') or git('merge-base', 'HEAD', 'origin/main').decode().strip()
    assert baseline == expected_base, 'Evidence baseline differs from PR base'
    assert re.fullmatch(r'[0-9a-f]{40}', head) and re.fullmatch(r'[0-9a-f]{40}', baseline)
    assert git('merge-base', '--is-ancestor', head, 'HEAD') == b''
    assert git('merge-base', '--is-ancestor', baseline, head) == b''
    assert evidence['reviewed_tree'] == git('rev-parse', f'{head}^{{tree}}').decode().strip(), 'Reviewed tree mismatch'
    assert evidence['review_result']['reviewed_head'] == head, 'Reviewer returned a different head'
    assert evidence['review_result']['findings'] == [], 'Findings must be resolved and re-reviewed'
    assert evidence['review_result']['verdict'].lower() in ('approve', 'approve_with_limitations', 'pass')
    reviewed = evidence['reviewed_files']
    expected = set(git('diff', '--name-only', '-z', baseline, head).decode().split('\0')) - {''}
    expected.discard(EVIDENCE)
    assert expected, 'Empty reviewed patch'
    assert set(reviewed) == expected, 'Evidence must cover every fix file'
    changed_now = set(git('diff', '--name-only', '-z', head, 'HEAD').decode().split('\0')) - {''}
    assert changed_now <= {EVIDENCE}, 'Additional changes require a fresh review'
    for name, digest in reviewed.items():
        assert safe_path(name), 'Unsafe evidence path'
        assert re.fullmatch(r'[0-9a-f]{64}', digest)
        assert hashlib.sha256(git('show', f'HEAD:{name}')).hexdigest() == digest, f'Review is stale for {name}'
    print(f'Recorded local Antigravity review validated: {family}, {requested}, fix head {head}.')
    print('This workflow validates a maintainer-recorded attestation; it does not run Antigravity or independently authenticate the reviewer.')


if __name__ == '__main__':
    try:
        validate()
    except (AssertionError, KeyError, ValueError, TypeError, AttributeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Local AI review evidence is missing, invalid, or stale: {error}', file=sys.stderr)
        sys.exit(1)
