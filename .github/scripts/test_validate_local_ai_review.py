"""Policy checks use synthetic repositories and never invoke a model."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_check', Path(__file__).with_name('validate-local-ai-review.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        review.ROOT = self.root
        self.git('init', '-q')
        (self.root / 'example.py').write_text('value = 1\n', encoding='utf-8')
        self.commit()
        self.baseline = self.git('rev-parse', 'HEAD').decode().strip()
        env = patch.dict(os.environ, {'EXPECTED_REVIEW_BASE': self.baseline})
        env.start()
        self.addCleanup(env.stop)
        (self.root / 'example.py').write_text('value = 2\n', encoding='utf-8')
        self.commit()
        self.head = self.git('rev-parse', 'HEAD').decode().strip()
        self.policy = {'active_family': 'gemini-flash'}
        self.evidence = {
            'provider': 'antigravity', 'mechanism': 'local-cli', 'family': 'gemini-flash',
            'requested_model': 'gemini-9.10-flash-high', 'confirmed_model': 'gemini-9.10-flash-high',
            'catalog_models': ['gemini-9.9-flash-high', 'gemini-9.10-flash-high', 'gemini-10.0-pro-high'],
            'reviewed_fix_head': self.head, 'baseline': self.baseline,
            'reviewed_tree': self.git('rev-parse', f'{self.head}^{{tree}}').decode().strip(),
            'review_result': {'reviewed_head': self.head, 'findings': [], 'verdict': 'PASS'},
            'reviewed_files': {'example.py': hashlib.sha256(b'value = 2\n').hexdigest()},
        }
        self.save()


    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL)

    def commit(self):
        self.git('add', '.')
        self.git('-c', 'user.name=ReviewTest', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')

    def save(self):
        for path, data in [('.github/ai-review-policy.json', self.policy), (review.EVIDENCE, self.evidence)]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data), encoding='utf-8')

    def test_valid_flash_attestation_and_numeric_latest_selection(self):
        review.validate()

    def test_rejects_actual_model_substitution(self):
        self.evidence['confirmed_model'] = 'gemini-9.9-flash-high'
        self.save()
        with self.assertRaisesRegex(AssertionError, 'substituted'):
            review.validate()

    def test_rejects_older_available_flash(self):
        self.evidence['requested_model'] = self.evidence['confirmed_model'] = 'gemini-9.9-flash-high'
        self.save()
        with self.assertRaisesRegex(AssertionError, 'newest'):
            review.validate()

    def test_rejects_changed_reviewed_source(self):
        (self.root / 'example.py').write_text('value = 3\n', encoding='utf-8')
        self.commit()
        with self.assertRaisesRegex(AssertionError, 'Additional'):
            review.validate()

    def test_rejects_unreviewed_additional_source(self):
        (self.root / 'other.py').write_text('value = 3\n', encoding='utf-8')
        self.commit()
        with self.assertRaisesRegex(AssertionError, 'Additional'):
            review.validate()

    def test_sonnet_requires_read_only_recovered_quota_evidence(self):
        self.policy['active_family'] = self.evidence['family'] = 'claude-sonnet'
        self.evidence['requested_model'] = self.evidence['confirmed_model'] = 'claude-sonnet-9-1'
        self.evidence['catalog_models'] = ['claude-sonnet-9-1']
        self.evidence['quota_recovery'] = {'status': 'exhausted', 'mechanism': 'read-only-status'}
        self.save()
        with self.assertRaises(AssertionError):
            review.validate()

    def test_rejects_unresolved_findings(self):
        self.evidence['review_result']['findings'] = [{'severity': 'high'}]
        self.save()
        with self.assertRaisesRegex(AssertionError, 'resolved'):
            review.validate()

    def test_rejects_forged_tree(self):
        self.evidence['reviewed_tree'] = '0' * 40
        self.save()
        with self.assertRaisesRegex(AssertionError, 'tree'):
            review.validate()

    def test_rejects_changed_workflow(self):
        target = self.root / '.github/workflows/claude.yml'
        target.parent.mkdir(parents=True)
        target.write_text('changed', encoding='utf-8')
        self.commit()
        with self.assertRaisesRegex(AssertionError, 'Additional'):
            review.validate()

    def test_rejects_path_injection(self):
        for path in ('../x', '/x', 'C:/x', 'a\\b', 'a\nb', 'a//b', 'a/./b', ':x'):
            with self.subTest(path=path):
                self.assertFalse(review.safe_path(path))

    def test_rejects_duplicate_json_keys(self):
        (self.root / review.EVIDENCE).write_text('{"family":"gemini-flash","family":"claude-sonnet"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            review.validate()

    def test_rejects_malformed_json(self):
        (self.root / review.EVIDENCE).write_text('{', encoding='utf-8')
        with self.assertRaises(ValueError):
            review.validate()

    def test_rejects_forged_baseline(self):
        self.evidence['baseline'] = self.head
        self.save()
        with self.assertRaisesRegex(AssertionError, 'baseline'):
            review.validate()

    def test_rejects_deleted_reviewed_file(self):
        (self.root / 'example.py').unlink()
        self.commit()
        with self.assertRaisesRegex(AssertionError, 'Additional'):
            review.validate()

    def test_rejects_missing_fields(self):
        del self.evidence['confirmed_model']
        self.save()
        with self.assertRaises(KeyError):
            review.validate()


if __name__ == '__main__':
    unittest.main()
