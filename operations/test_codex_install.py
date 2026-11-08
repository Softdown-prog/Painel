"""Regression for actual 16-overlay host, no Docker or production writes."""
import ast
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import codex
import install_codex as bootstrap

ROOT = Path(__file__).resolve().parent


class Bootstrap(unittest.TestCase):
    def test_driver_preserves_shadow_and_unknown_adapters_byte_for_byte(self):
        source = """def verify_project(project, args):
    if project.get('adapter') == 'shadow':
        from shadow import verify_shadow
        return verify_shadow(project, args)
def deploy(project, args, token, state):
    contract(project)
    images = prepare_images(project, args, token, None)
    sha = args['sha']
    log = None
    admission = admit(project, sha, images)
    if project['adapter'] == 'shadow':
        from shadow import shadow_activate
        return dict(shadow_activate(project, sha, images, log), admission=admission)
    return existing_custom_deploy(project)
"""
        result = bootstrap.patch_driver(source)
        self.assertIn("if project['adapter'] == 'codex':", result)
        self.assertIn('from shadow import shadow_activate', result)
        block = "    if project['adapter'] == 'codex':\n        from codex import codex_activate\n        return dict(codex_activate(project, sha, images, log), admission=admission)\n"
        self.assertEqual(result.replace(block, ''), source)
        self.assertEqual(bootstrap.patch_driver(result), result)
        self.assertEqual(bootstrap.patch_driver((ROOT/'driver.py').read_text()), (ROOT/'driver.py').read_text())
        with self.assertRaises(ValueError):
            bootstrap.patch_driver(source.replace('admission = admit', 'other = admit'))

    def test_only_known_admission_upgrades_are_allowed(self):
        reference = (ROOT/'admission.py').read_text()
        legacy = ast.unparse(bootstrap.WithoutCodex().visit(ast.parse(reference)))
        self.assertEqual(bootstrap.patch_admission(legacy, reference), reference)
        self.assertEqual(bootstrap.patch_admission(reference, reference), reference)
        with self.assertRaises(ValueError):
            bootstrap.patch_admission(legacy+'\nCUSTOM_SECURITY=True\n', reference)

    def test_policy_extension_never_requires_or_adds_panel_web(self):
        policy = json.loads((ROOT/'policy.example.json').read_text())
        policy['projects'].pop('panel-codex')
        policy['projects'].pop('panel-web')
        repo = policy['repositories']['1433232532']
        repo['projects'] = ['panel', 'infrastructure', 'terrania']
        repo['workflows'].remove('stage-codex-bridge.yml')
        original = copy.deepcopy(policy)
        targets, result = bootstrap.plan(ROOT.parent, ROOT, policy)
        self.assertEqual(policy, original)
        self.assertNotIn('panel-web', result['projects'])
        self.assertEqual(result['repositories']['1438758092'], policy['repositories']['1438758092'])
        self.assertEqual(result['repositories']['1433232532']['operations'], repo['operations'])
        self.assertEqual(set(targets), {ROOT/name for name in ('driver.py','admission.py','codex.py')})


class InstalledCompose(unittest.TestCase):
    def test_sixteen_registered_overlays_select_last_codex_image_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ['compose.yaml'] + ['compose.'+name+'.yaml' for name in
                     ['apps','ghcr','ghcr-private','github','projects','releases','revisions',
                      'ssh-terminal','publications','secrets','routing','install','postgres',
                      'codex-local','agent-operations-local']]
            for name in names:
                (root/name).write_text(json.dumps({'services':{}}))
            target = root/names[-1]
            target.write_text(json.dumps({'services':{codex.SERVICE:{'image':'installed'}}}))
            api={'Config':{'Labels':{'com.docker.compose.project.config_files':','.join(str(root/n) for n in names)}}}
            with patch.object(codex,'PANEL_CURRENT',root), patch.object(codex,'_root_owned',return_value=True):
                args, overlay = codex._compose_args(api)
                self.assertEqual(overlay,target)
                self.assertEqual([args[i+1] for i,v in enumerate(args) if v=='-f'],[str(root/n) for n in names])
                self.assertIn('--project-directory',args)
                with patch.object(codex,'_root_owned',return_value=False),self.assertRaises(ValueError):
                    codex._compose_args(api)
                labels=api['Config']['Labels'];labels['com.docker.compose.project.config_files']+=','+str(target)
                with self.assertRaises(ValueError):codex._compose_args(api)

    def test_active_or_unconfirmed_chat_blocks_rollout(self):
        for value in ({'ready':True,'active':True},{'ready':False,'active':False},{'ready':True}):
            with self.subTest(value=value),patch.object(codex,'run',return_value=json.dumps(value)),self.assertRaises(ValueError):
                codex._assert_idle()
        with patch.object(codex,'run',return_value=json.dumps({'ready':True,'active':False})):
            codex._assert_idle()


if __name__ == '__main__':
    unittest.main()
