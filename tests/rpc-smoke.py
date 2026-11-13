"""Offline native Pi checks; synthetic data and a loopback-only mock provider."""
import argparse
import json
import os
from pathlib import Path
from queue import Queue, Empty
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

QUESTIONS = "1. Which incompatible output contract should the prompt require?"
FINAL = "# Role\nSynthetic assistant.\n\n# Context\nA disposable fixture.\n\n# Task\nReply only SYNTHETIC_EXECUTED.\n\n# Constraints\nDo not call tools.\n\n# Output Format\nPlain text.\n"
REVISED = FINAL.replace("SYNTHETIC_EXECUTED", "SYNTHETIC_REVISED")
ANSWER = "Audience: tests. Outcome: synthetic reply. Constraints: no tools."


class Handler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        last = [m['content'] for m in body['messages'] if m['role'] == 'user'][-1]
        if isinstance(last, list):
            last = '\n'.join(p['text'] for p in last if p['type'] == 'text')
        type(self).requests.append(last)
        if last.startswith('Act as an expert prompt engineer.'):
            text = ('Here is your prompt:\n' + FINAL if last.endswith('malformed synthetic reply') else
                    FINAL if last.endswith('sufficient synthetic context') else QUESTIONS)
        elif last == ANSWER:
            text = FINAL
        else:
            assert last in (FINAL, REVISED), 'Unexpected synthetic dispatch'
            text = 'SYNTHETIC_EXECUTED'
        chunks = [
            {'id': 'mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'mock',
             'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]},
            {'id': 'mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'mock',
             'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
        ]
        data = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks).encode() + b'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Client:
    def __init__(self, agent, cwd, extension):
        env = {k: os.environ[k] for k in ('HOME', 'PATH', 'LANG', 'TMPDIR') if k in os.environ}
        env['PI_CODING_AGENT_DIR'] = str(agent)
        self.proc = subprocess.Popen([
            'pi', '--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp',
            '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-tools',
            '--provider', 'mock', '--model', 'mock', '-e', str(extension),
        ], cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.lines = Queue()
        threading.Thread(target=lambda: [self.lines.put(line) for line in self.proc.stdout], daemon=True).start()
        self.serial = 0
        self.assistants = []
        self.editors = []
        self.choices = []
        self.notices = []

    def send(self, value):
        self.proc.stdin.write(json.dumps(value) + '\n')
        self.proc.stdin.flush()

    def event(self, interaction=None):
        try:
            event = json.loads(self.lines.get(timeout=20))
        except Empty:
            raise AssertionError('Timed out waiting for native Pi RPC')
        if event.get('type') == 'extension_ui_request':
            method = event['method']
            if method == 'notify':
                self.notices.append(event['message'])
                assert event.get('notifyType') != 'error', event['message']
            elif method in ('select', 'editor', 'confirm', 'input'):
                assert interaction, f'Unexpected {method} dialog'
                if method == 'editor':
                    self.editors.append(event)
                elif method == 'select':
                    self.choices.append(event)
                response = interaction(event)
                self.send({'type': 'extension_ui_response', 'id': event['id'], **response})
        if event.get('type') == 'message_end' and event['message'].get('role') == 'assistant':
            self.assistants.append('\n'.join(p['text'] for p in event['message']['content'] if p['type'] == 'text'))
        return event

    def command(self, message, model=False, interaction=None):
        self.serial += 1
        ident = f'command-{self.serial}'
        self.send({'id': ident, 'type': 'prompt', 'message': message})
        acknowledged, settled = False, False
        while not acknowledged or (model and not settled):
            event = self.event(interaction)
            if event.get('id') == ident and event.get('type') == 'response':
                assert event.get('success'), event
                acknowledged = True
            if event.get('type') == 'agent_settled':
                settled = True

    def check_commands(self):
        self.serial += 1
        ident = f'commands-{self.serial}'
        self.send({'id': ident, 'type': 'get_commands'})
        while True:
            event = self.event()
            if event.get('id') == ident and event.get('type') == 'response':
                assert event.get('success'), event
                names = [c['name'] for c in event['data']['commands']]
                for name in ('metaprompt', 'metaprompt-mode'):
                    assert [n for n in names if n == name or n.startswith(name + ':')] == [name], names
                return

    def await_execution(self):
        while not self.assistants or self.assistants[-1] != 'SYNTHETIC_EXECUTED':
            self.event()
        # The execution's final settle is a barrier before checking for extra dispatches.
        while self.event().get('type') != 'agent_settled':
            pass

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extension', type=Path, default=Path(__file__).resolve().parents[1] / 'index.ts')
    extension = parser.parse_args().extension.resolve()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cases = ['response-only', 'immediate', 'persisted-immediate', 'approval', 'revise',
             'cancel-preview', 'decline', 'mode-change', 'malformed',
             'direct-response-only', 'direct-immediate', 'direct-approval']
    try:
        with tempfile.TemporaryDirectory(prefix='metaprompt-rpc-') as directory:
            root = Path(directory)
            agent = root / 'agent'
            agent.mkdir()
            (agent / 'models.json').write_text(json.dumps({'providers': {'mock': {
                'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'api': 'openai-completions',
                'apiKey': 'fake', 'models': [{'id': 'mock', 'name': 'Mock'}],
            }}}))
            for case in cases:
                client = Client(agent, root, extension)
                start = len(Handler.requests)
                try:
                    client.check_commands()
                    if case == 'response-only':
                        client.command('/metaprompt-mode status')
                        assert any('response-only' in n for n in client.notices)
                        assert not (agent / 'metaprompt.json').exists(), 'Default must require no config write'
                    elif case == 'immediate':
                        client.command('/metaprompt-mode', interaction=lambda e: {'value': 'Immediate'})
                    elif case == 'persisted-immediate':
                        client.command('/metaprompt-mode status')
                        assert any('immediate' in n for n in client.notices)
                        assert json.loads((agent / 'metaprompt.json').read_text())['mode'] == 'immediate'
                    else:
                        mode = case.removeprefix('direct-') if case.startswith('direct-') else 'immediate' if case == 'malformed' else 'approval'
                        client.command('/metaprompt-mode ' + mode)
                    assert len(Handler.requests) == start, 'Loading/command checks or mode selection started a model call'
                    def interact(event):
                        if event['method'] == 'editor':
                            assert event['prefill'] in (FINAL, REVISED)
                            if case in ('cancel-preview', 'mode-change'):
                                return {'cancelled': True}
                            return {'value': REVISED if case == 'revise' else event['prefill']}
                        assert event['method'] == 'select' and 'execute this prompt' in event['title']
                        if case == 'decline':
                            return {'value': 'Cancel'}
                        if case == 'revise' and len(client.choices) == 1:
                            return {'value': 'Revise'}
                        return {'value': 'Execute'}
                    direct = case.startswith('direct-')
                    goal = ('malformed synthetic reply' if case == 'malformed' else
                            'sufficient synthetic context' if direct else 'Write a synthetic reply')
                    client.command('/metaprompt ' + goal, model=True, interaction=interact)
                    if case == 'malformed':
                        assert len(Handler.requests) == start + 1, 'Malformed output dispatched a task'
                        assert client.assistants[-1] == 'Here is your prompt:\n' + FINAL
                        assert any('expected a final prompt or numbered clarification' in n for n in client.notices)
                        continue
                    if not direct:
                        assert len(Handler.requests) == start + 1, 'Clarification dispatched a task'
                        assert client.assistants[-1] == QUESTIONS
                        if case == 'mode-change':
                            client.command('/metaprompt-mode immediate')
                        client.command(ANSWER, model=True, interaction=interact)
                    executes = case in ('immediate', 'persisted-immediate', 'approval', 'revise', 'direct-immediate', 'direct-approval')
                    if executes:
                        client.await_execution()
                        assert Handler.requests[-1] == (REVISED if case == 'revise' else FINAL)
                    else:
                        assert client.assistants[-1] == FINAL
                    assert len(Handler.requests) - start == 1 + (not direct) + executes, case
                    assert not any('Metaprompt stopped:' in n for n in client.notices), client.notices
                    if case == 'revise':
                        assert len(client.editors) == 2 and client.editors[1]['prefill'] == REVISED
                    if case in ('cancel-preview', 'mode-change'):
                        assert len(client.editors) == 1 and not client.choices
                finally:
                    client.close()
            print(f'Pi RPC smoke passed: {len(cases)} synthetic cases, single command registration, direct/clarified generation, all modes, revision, cancellation, persistence and exact dispatch.')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
