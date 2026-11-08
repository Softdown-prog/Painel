import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gc_install', Path(__file__).with_name('install-storage-cleanup.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_checksum_update_is_bound_to_executable_not_volume_path(self):
        self.exercise('correct', True)

    def test_wrong_hash_and_changed_unit_refuse_before_any_write(self):
        self.exercise('wrong', False)
        self.exercise('unit-drift', False)

    def exercise(self, mode, succeeds):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'source'; data=root/'data'; units=root/'units'
            for d in [source,data,units]:d.mkdir()
            executable=root/'program';executable.write_bytes(b'old-program')
            (source/'storage_cleanup.py').write_bytes(b'new-program')
            for suffix in ['service','timer','path']:
                name='vps-storage-cleanup.'+suffix
                (source/name).write_bytes(b'fixed-unit')
                (units/name).write_bytes(b'drifted-unit' if mode=='unit-drift' and suffix=='service' else b'fixed-unit')
            expected=hashlib.sha256(b'old-program').hexdigest() if mode!='wrong' else '0'*64
            with patch.object(installer,'SOURCE',source),patch.object(installer,'DATA',data),\
                 patch.object(installer,'SYSTEMD',units),patch.object(installer,'EXECUTABLE',executable),\
                 patch.object(installer.os,'geteuid',return_value=0,create=True),\
                 patch.object(installer.subprocess,'check_output',return_value=json.dumps([{'Mountpoint':str(data)}])),\
                 patch.object(installer.subprocess,'run') as run:
                if succeeds:
                    installer.install_checked(expected)
                    self.assertEqual(executable.read_bytes(),b'new-program')
                    self.assertEqual(run.call_count,2)
                else:
                    with self.assertRaises(ValueError):installer.install_checked(expected)
                    self.assertEqual(executable.read_bytes(),b'old-program')
                    run.assert_not_called()


if __name__=='__main__':unittest.main()
