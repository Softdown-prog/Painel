"""Verify opt-in cleanup services remain safe and survive host restarts."""
from pathlib import Path
import unittest

OPERATIONS=Path(__file__).resolve().parent

class TestTerminalGcUnits(unittest.TestCase):
    def test_persistent_timer_survives_host_reboot(self):
        timer=(OPERATIONS/'systemd/vps-panel-terminal-gc.timer').read_text()
        self.assertIn('OnBootSec=5min',timer)
        self.assertIn('OnCalendar=*:0/15',timer)
        self.assertIn('Persistent=true',timer)
        self.assertIn('Unit=vps-panel-terminal-gc.service',timer)
        self.assertIn('WantedBy=timers.target',timer)

    def test_service_is_root_only_and_may_write_only_private_job_state(self):
        service=(OPERATIONS/'systemd/vps-panel-terminal-gc.service').read_text()
        self.assertIn('Type=oneshot',service)
        self.assertIn('ExecStart=/usr/local/libexec/vps-panel-terminal-jobs prune',service)
        self.assertIn('User=root',service)
        self.assertIn('ProtectSystem=strict',service)
        self.assertIn('ReadWritePaths=/var/lib/vps-panel-terminal-jobs',service)
        self.assertIn('NoNewPrivileges=yes',service)
        self.assertNotIn('/bin/sh -c',service)

    def test_manual_apply_installs_and_enables_timer_without_deploying_api(self):
        script=(OPERATIONS/'install-terminal-host-jobs.sh').read_text()
        self.assertIn('check|apply',script)
        self.assertIn('systemctl enable --now vps-panel-terminal-gc.timer',script)
        self.assertIn("if [[ \"$mode\" == 'check' ]]",script)
        self.assertIn('exit 0',script)
        self.assertNotIn('docker compose up',script)
        self.assertNotIn('systemctl restart',script)

if __name__=='__main__':
    unittest.main()
