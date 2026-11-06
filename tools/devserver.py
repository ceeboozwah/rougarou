#!/usr/bin/env python3
"""serve web/ with no caching, and give the AI climber its two things: a way to OpenAI that keeps the key on this machine, and a notebook.

    OPENAI_API_KEY=sk-... python3 tools/devserver.py          # then open http://localhost:8765/
    OPENAI_MODEL=gpt-4o-mini AI_MAX_CALLS=400 PORT=8765 ...    # optional

the key is read from the environment here and never sent to the browser. POST /ai/chat forwards {messages} to the chat completions
endpoint (json answers only) and refuses after AI_MAX_CALLS calls in one run, a hard stop on the bill. GET /ai/status says whether a key is set.
GET and POST /ai/memory keep the climber's notebook in tools/.cache/ai-memory.json. only this machine can use /ai/*.
"""
import http.server, json, os, re, sys, functools, urllib.request, urllib.error, threading

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

    def save_limits(self):
        # the pose restriction editor's save: web/limits.json, one joint to a line, only from this machine and only a well formed set
        if not self.local():
            return self.reply(403, {'error': 'local only'})
        try:
            data = self.body()
            limits = data['limits']
            mix = data.get('mix')
            if mix is not None:
                assert isinstance(mix, dict) and len(mix) <= 12 and all(re.fullmatch(r'[a-z0-9]{2,12}', k) and isinstance(v, (int, float)) and 0 <= v <= 1 for k, v in mix.items())
            assert isinstance(limits, dict) and len(limits) < 200
            for name, entry in limits.items():
                assert re.fullmatch(r'[LR]?_?[A-Za-z0-9]{2,20}', name)
                assert isinstance(entry, dict) and set(entry) <= {'fwd', 'back', 'out', 'inn', 'twist'}
                for axis, value in entry.items():
                    if axis == 'twist':
                        assert isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) and -360 <= v <= 360 for v in value) and value[0] <= value[1]
                    else:
                        assert isinstance(value, (int, float)) and 0 <= value <= 180
        except Exception:
            return self.reply(400, {'error': 'that is not a set of joint limits'})
        path = os.path.join(ROOT, 'limits.json')
        os.makedirs(os.path.join(CACHE, 'limit-backups'), exist_ok=True)
        if mix is None and os.path.exists(path):
            try:
                with open(path) as f: mix = json.load(f).get('mix')
            except Exception:
                mix = None
        if os.path.exists(path):
            import shutil, time
            shutil.copy(path, os.path.join(CACHE, 'limit-backups', f'limits-{int(time.time())}.json'))
        lines = ',\n'.join(f'  {json.dumps(k)}: {json.dumps(limits[k], separators=(",", ":"))}' for k in sorted(limits))
        with open(path + '.tmp', 'w') as f:
            f.write('{"version": 1, ' + (f'"mix": {json.dumps(mix, separators=(",", ":"))}, ' if mix else '') + '"limits": {\n' + lines + '\n}}\n')
        os.replace(path + '.tmp', path)
        return self.reply(200, {'ok': True, 'joints': len(limits)})

    def save_wall(self):
        # the endless wall drawn under the skeleton's gate (web/wallbake.js): its panel angles and every chunk's holds, so the game does not have to draw them again
        if not self.local():
            return self.reply(403, {'error': 'local only'})
        try:
            data = self.body()
            lean, holds = data['lean'], data['holds']
            assert isinstance(lean, list) and len(lean) < 5000 and all(isinstance(v, (int, float)) for v in lean)
            assert isinstance(holds, list) and len(holds) < 1000
            for chunk in holds:
                assert isinstance(chunk, list) and len(chunk) < 600
                for h in chunk:
                    assert isinstance(h['kind'], str) and len(h['kind']) < 12
                    assert all(isinstance(v, (int, float)) for v in (h['x'], h['y'], h['px'], h['py'], h['line']))
        except Exception:
            return self.reply(400, {'error': 'that is not a baked wall'})
        path = os.path.join(ROOT, 'wall-baked.json')
        os.makedirs(os.path.join(CACHE, 'wall-backups'), exist_ok=True)
        if os.path.exists(path):
            import shutil, time
            shutil.copy(path, os.path.join(CACHE, 'wall-backups', f'wall-{int(time.time())}.json'))
        with open(path + '.tmp', 'w') as f:
            json.dump({'version': 1, 'gate': True, 'chunks': len(holds), 'lean': lean, 'holds': holds}, f, separators=(',', ':'))
        os.replace(path + '.tmp', path)
        return self.reply(200, {'ok': True, 'chunks': len(holds)})

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
        if self.path == '/dev/limits':
            return self.save_limits()
        if self.path == '/dev/wall':
            return self.save_wall()
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
