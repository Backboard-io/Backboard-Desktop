import unittest
import queue
from test_model_chats import Bridge, validate_turn

class ChatAssertions(unittest.TestCase):
    def records(self, text, status='completed'):
        return [{'type': 'assistant:delta', 'payload': {'text': text}},
                {'type': 'turn:end', 'payload': {'status': status}}]

    def test_streamed_token_may_span_chunks(self):
        records = self.records('release_')
        records.insert(1, {'type': 'assistant:delta', 'payload': {'text': 'abc'}})
        self.assertEqual(validate_turn(records, 'release_abc'), 11)

    def test_blank_or_unrelated_answer_fails(self):
        for text in ('', 'Hello'):
            with self.assertRaises(RuntimeError):
                validate_turn(self.records(text), 'release_abc')

    def test_error_or_cancelled_completion_fails(self):
        for status in ('error', 'cancelled', None):
            with self.assertRaises(RuntimeError):
                validate_turn(self.records('release_abc', status), 'release_abc')

    def test_final_message_without_stream_does_not_pass(self):
        records = self.records('release_abc')
        records[0]['type'] = 'assistant:message'
        with self.assertRaises(RuntimeError):
            validate_turn(records, 'release_abc')

class TransportFailures(unittest.TestCase):
    def bridge(self):
        bridge = Bridge.__new__(Bridge)
        bridge.timeout = 0.01
        bridge.events = queue.Queue()
        return bridge

    def test_timeout_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'Timed out'):
            self.bridge().receive('turn:end')

    def test_errors_exit_and_tools_fail_closed(self):
        for kind in ('process:exit', 'serve:error', 'run:error', 'tool:start', 'input:request', 'client_tool:call'):
            bridge = self.bridge()
            bridge.events.put({'type': kind})
            with self.assertRaisesRegex(RuntimeError, kind):
                bridge.receive('turn:end')

if __name__ == '__main__':
    unittest.main()
