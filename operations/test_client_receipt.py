import json
import subprocess
import unittest
from unittest.mock import patch
import client


class ReceiptRecovery(unittest.TestCase):
    payload = {'id': 'run-123-deploy-panel', 'args': {'sha': 'a' * 40}, 'oidc': 'synthetic'}

    def response(self, code=0, result=None, stdout=None):
        if result is None:
            result = {'id': self.payload['id'], 'exitCode': 0, 'duplicate': True}
        return subprocess.CompletedProcess(['ssh'], code, json.dumps(result) if stdout is None else stdout, '')

    def test_lost_transport_recovers_receipt_using_identical_request(self):
        with patch.object(client.subprocess, 'run', side_effect=[self.response(255, stdout=''), self.response()]) as run, \
             patch.object(client.time, 'sleep') as sleep:
            result = client.execute_ssh(['ssh', 'fixture'], self.payload)
        self.assertEqual(result['exitCode'], 0)
        self.assertTrue(result['duplicate'])
        self.assertEqual(run.call_args_list[0], run.call_args_list[1])
        self.assertEqual(json.loads(run.call_args.kwargs['input']), self.payload)
        sleep.assert_called_once_with(30)

    def test_recorded_operation_failure_is_not_reexecuted(self):
        failure = {'id': self.payload['id'], 'exitCode': 1, 'error': 'healthcheck failed'}
        with patch.object(client.subprocess, 'run', return_value=self.response(1, failure)) as run:
            self.assertEqual(client.execute_ssh(['ssh'], self.payload), failure)
        run.assert_called_once()

    def test_complete_authenticated_receipt_survives_missing_ssh_exit_status(self):
        with patch.object(client.subprocess, 'run', return_value=self.response(255)) as run:
            self.assertEqual(client.execute_ssh(['ssh'], self.payload)['exitCode'], 0)
        run.assert_called_once()

    def test_different_request_receipt_and_invalid_payload_are_rejected(self):
        for result in [{'id': 'other-job', 'exitCode': 0}, [], {'id': self.payload['id'], 'exitCode': False}]:
            with self.subTest(result=result), patch.object(client.subprocess, 'run', return_value=self.response(0, result)):
                self.assertEqual(client.execute_ssh(['ssh'], self.payload)['exitCode'], 1)

    def test_transport_recovery_is_bounded_without_raw_stderr(self):
        response = self.response(255, stdout='not-json')
        response.stderr = 'synthetic-secret-must-not-escape'
        with patch.object(client.subprocess, 'run', return_value=response) as run, patch.object(client.time, 'sleep'):
            result = client.execute_ssh(['ssh'], self.payload)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(result['exitCode'], 1)
        self.assertNotIn('synthetic-secret', json.dumps(result))


    def test_categorizes_ssh_errors_without_echoing_raw_stderr(self):
        samples = (
            ('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host_key_verification_failed'),
            ('Host key verification failed.', 'host_key_verification_failed'),
            ('Load key /tmp/private: error in libcrypto', 'invalid_private_key'),
            ('vpsops@host: Permission denied (publickey).', 'authentication_failed'),
            ('ssh: connect to host host port 22: Connection refused', 'connection_refused'),
            ('ssh: connect to host host port 22: Connection timed out', 'connection_timed_out'),
            ('ssh: connect to host host port 22: Network is unreachable', 'network_unreachable'),
            ('ssh: Could not resolve hostname bad-host: Name or service not known', 'dns_resolution_failed'),
            ('kex_exchange_identification: Connection closed by remote host', 'connection_closed'),
        )
        for message, expected in samples:
            response = self.response(255, stdout='')
            response.stderr = message + ' secret-key-canary'
            with self.subTest(expected=expected), patch.object(client.subprocess, 'run', return_value=response) as run, \\
                 patch.object(client.time, 'sleep') as sleep:
                result = client.execute_ssh(['ssh'], self.payload)
            self.assertEqual(result['transportCategory'], expected)
            self.assertEqual(result['transportExitCode'], 255)
            self.assertEqual(result['attempts'], 1 if expected in (
                'host_key_verification_failed', 'invalid_private_key',
                'authentication_failed', 'dns_resolution_failed') else 2)
            self.assertNotIn('secret-key-canary', json.dumps(result))
            self.assertNotIn('host port 22', json.dumps(result))
            if expected in ('host_key_verification_failed', 'invalid_private_key',
                            'authentication_failed', 'dns_resolution_failed'):
                run.assert_called_once()
                sleep.assert_not_called()

    def test_unknown_ssh_failure_keeps_bounded_receipt_retry(self):
        response = self.response(255, stdout='')
        response.stderr = 'arbitrary sensitive failure secret-key-canary'
        with patch.object(client.subprocess, 'run', return_value=response) as run, \\
             patch.object(client.time, 'sleep') as sleep:
            result = client.execute_ssh(['ssh'], self.payload)
        self.assertEqual(result['transportCategory'], 'unknown_transport_error')
        self.assertEqual(result['attempts'], 2)
        self.assertNotIn('secret-key-canary', json.dumps(result))
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(30)

    def test_no_receipt_with_successful_ssh_is_invalid_response(self):
        with patch.object(client.subprocess, 'run', return_value=self.response(0, stdout='not-json')) as run:
            result = client.execute_ssh(['ssh'], self.payload)
        self.assertEqual(result['transportCategory'], 'invalid_executor_response')
        self.assertEqual(result['transportExitCode'], 0)
        run.assert_called_once()

    def test_ssh_timeout_or_missing_binary_returns_safe_diagnostic(self):
        with patch.object(client.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 1600, output='secret-key-canary')):
            timeout = client.execute_ssh(['ssh'], self.payload)
        self.assertEqual(timeout['transportCategory'], 'ssh_command_timeout')
        self.assertNotIn('secret-key-canary', json.dumps(timeout))
        with patch.object(client.subprocess, 'run', side_effect=FileNotFoundError('raw secret path')):
            absent = client.execute_ssh(['ssh'], self.payload)
        self.assertEqual(absent['transportCategory'], 'ssh_client_unavailable')
        self.assertNotIn('raw secret path', json.dumps(absent))

    def test_missing_configured_secrets_fails_before_oidc(self):
        with patch.dict(client.os.environ, {'VPS_SSH_KEY': '', 'VPS_KNOWN_HOSTS': ''}, clear=True), \\
             patch.object(client, 'publish_result', return_value=1) as publish:
            exit_code = client.main()
        self.assertEqual(exit_code, 1)
        result = publish.call_args.args[0]
        self.assertEqual(result['transportCategory'], 'missing_ssh_configuration')
        self.assertEqual(result['missingSettings'], ['VPS_SSH_KEY', 'VPS_KNOWN_HOSTS'])
        self.assertNotIn('raw', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
