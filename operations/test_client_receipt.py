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


if __name__ == '__main__':
    unittest.main()
