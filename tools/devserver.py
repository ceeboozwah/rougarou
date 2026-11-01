#!/usr/bin/env python3
"""serve web/ with no caching, and give the AI climber its two things: a way to OpenAI that keeps the key on this machine, and a notebook.

    OPENAI_API_KEY=sk-... python3 tools/devserver.py          # then open http://localhost:8765/
    OPENAI_MODEL=gpt-4o-mini AI_MAX_CALLS=400 PORT=8765 ...    # optional

the key is read from the environment here and never sent to the browser. POST /ai/chat forwards {messages} to the chat completions
endpoint (json answers only) and refuses after AI_MAX_CALLS calls in one run, a hard stop on the bill. GET /ai/status says whether a key is set.
GET and POST /ai/memory keep the climber's notebook in tools/.cache/ai-memory.json. only this machine can use /ai/*.
"""
import http.server, json, os, sys, functools, urllib.request, urllib.error, threading

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
MEMORY = os.path.join(CACHE, 'ai-memory.json')
PORT = int(os.environ.get('PORT', '8765'))
MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')
CAP = int(os.environ.get('AI_MAX_CALLS', '400'))
calls = {'n': 0}
lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    def local(self):
        return self.client_address[0] in ('127.0.0.1', '::1')

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length', '0'))
        if n > 400_000:
            raise ValueError('too large')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path == '/ai/status':
            if not self.local(): return self.reply(403, {'error': 'local only'})
            return self.reply(200, {'key': bool(os.environ.get('OPENAI_API_KEY')), 'model': MODEL, 'calls': calls['n'], 'cap': CAP})
        if self.path == '/ai/memory':
            if not self.local(): return self.reply(403, {'error': 'local only'})
            try:
                with open(MEMORY) as f: return self.reply(200, json.load(f))
            except Exception:
                return self.reply(200, {})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith('/ai/') or not self.local():
            return self.reply(403, {'error': 'not allowed'})
        try:
            data = self.body()
        except Exception as e:
            return self.reply(400, {'error': str(e)})
        if self.path == '/ai/memory':
            os.makedirs(CACHE, exist_ok=True)
            tmp = MEMORY + '.tmp'
            with open(tmp, 'w') as f: json.dump(data, f)
            os.replace(tmp, MEMORY)
            return self.reply(200, {'ok': True})
        if self.path != '/ai/chat':
            return self.reply(404, {'error': 'unknown'})
        key = os.environ.get('OPENAI_API_KEY')
        if not key:
            return self.reply(501, {'error': 'no OPENAI_API_KEY in this server\'s environment'})
        with lock:
            if calls['n'] >= CAP:
                return self.reply(429, {'error': f'call cap of {CAP} reached; restart the server to reset it'})
            calls['n'] += 1
        messages = data.get('messages')
        if not isinstance(messages, list) or not messages:
            return self.reply(400, {'error': 'messages missing'})
        payload = json.dumps({'model': MODEL, 'messages': messages, 'response_format': {'type': 'json_object'},
                              'temperature': float(data.get('temperature', 0.7)), 'max_tokens': 500}).encode()
        req = urllib.request.Request('https://api.openai.com/v1/chat/completions', payload,
                                     {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                out = json.load(r)
            return self.reply(200, {'content': out['choices'][0]['message']['content'], 'calls': calls['n'], 'cap': CAP,
                                    'usage': out.get('usage', {})})
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf8', 'replace')[:300]
            return self.reply(502, {'error': f'openai {e.code}', 'detail': detail})
        except Exception as e:
            return self.reply(502, {'error': str(e)[:200]})


if __name__ == '__main__':
    print(f'rougarou at http://localhost:{PORT}/  ({"key set" if os.environ.get("OPENAI_API_KEY") else "no OPENAI_API_KEY: the AI climber will use its own rehearsal"}, model {MODEL}, cap {CAP} calls)')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
