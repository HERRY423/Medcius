import importlib.util
from pathlib import Path
import io,json,tempfile,unittest,zipfile
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('release_package',Path(__file__).resolve().parents[1]/'scripts/package-release.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
REQUIRED=['.codex-plugin/plugin.json','.claude-plugin/icon.png','assets/medcius-icon-128.png','assets/medcius-icon-512.png','scripts/codex-mcp-server.mjs','lib/plugin-version.mjs','runtimes/cn-phi-ner/package-lock.json']

class ReleasePackageTests(unittest.TestCase):
    def run_build(self,extra=None,version='1.0.0',tag='V1.0.0'):
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:
            for name in REQUIRED+(extra or []):z.writestr('medcius/'+name,'synthetic')
        def git(args):
            command=args[3]
            if command=='rev-parse':return b'a'*40+b'\n'
            if command=='show':return json.dumps({'version':version}).encode()
            if command=='archive':return buf.getvalue()
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as d,patch.object(module.subprocess,'check_output',side_effect=git):
            module.build(tag,d)
            receipt=json.loads((Path(d)/'release-manifest.json').read_text())
            self.assertEqual(receipt['commit'],'a'*40)
            self.assertFalse(receipt['models_bundled'])
            self.assertTrue((Path(d)/'SHA256SUMS.txt').is_file())
    def test_valid_committed_package(self):self.run_build()
    def test_version_mismatch(self):
        with self.assertRaisesRegex(ValueError,'RELEASE_VERSION_MISMATCH'):self.run_build(version='0.10.0-pilot')
    def test_runtime_data_rejected(self):
        for name in ['runtimes/model.onnx','data/audit.sqlite','data/audit.sqlite-wal','.env','node_modules/pkg/index.js']:
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'RELEASE_FORBIDDEN_ASSET'):self.run_build(extra=[name])
    def test_invalid_tag_rejected(self):
        with self.assertRaisesRegex(ValueError,'RELEASE_TAG_INVALID'):self.run_build(tag='../../outside')

if __name__=='__main__':unittest.main()
