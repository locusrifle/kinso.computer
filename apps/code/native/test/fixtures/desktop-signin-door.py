"""Disposable real OS door; only canonical-store transport is mapped to loopback.

The absolute-deadline production subprocess uses this same fixture bootstrap,
then the unmodified production introspection job, with bearer only on stdin.
"""
import importlib.util
import os
import socket
import sys
import urllib.request

sys.dont_write_bytecode = True

# Enforce even if a future production job changes its HTTP implementation.
# Refuse external DNS *before* lookup and reject non-loopback TCP connects.
real_lookup = socket.getaddrinfo
real_connect = socket.socket.connect

def loopback_lookup(host, *args, **kwargs):
    if host not in ('127.0.0.1', '::1', None):
        raise ValueError('fixture DNS denied')
    return real_lookup(host, *args, **kwargs)

def loopback_connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in ('127.0.0.1', '::1'):
        raise ValueError('fixture TCP denied')
    return real_connect(self, address)

socket.getaddrinfo = loopback_lookup
socket.socket.connect = loopback_connect


def map_transport(store, adapter):
    real_open = urllib.request.OpenerDirector.open

    def loopback_open(self, request, *args, **kwargs):
        url = request.full_url if isinstance(request, urllib.request.Request) else request
        if url != store + '/account/desktop/introspect':
            raise ValueError('fixture outbound request denied')
        mapped = urllib.request.Request(adapter + url[len(store):], data=request.data,
                                       headers=dict(request.headers), method=request.get_method())
        return real_open(self, mapped, *args, **kwargs)

    urllib.request.OpenerDirector.open = loopback_open


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if sys.argv[1] == '--introspect':
    _, _, source, adapter, store = sys.argv
    map_transport(store, adapter)
    try:
        load(source, 'fixture_real_introspection').main()
    except Exception:
        sys.exit(1)  # Never print request/credential/URL/upstream exception.
    sys.exit(0)

from http.server import ThreadingHTTPServer

source, adapter = sys.argv[1:]
store = os.environ['DOOR_SSO_STORE']
map_transport(store, adapter)
door = load(source, 'fixture_real_door')
if hasattr(door, 'INTROSPECT_COMMAND'):
    # Only this test-loaded module is changed, not production source/config.
    # Deadline/semaphore/kill/reap and real job validation stay untouched.
    door.INTROSPECT_COMMAND = [sys.executable, '-I', __file__, '--introspect',
                               os.path.join(os.path.dirname(source), 'introspect.py'), adapter, store]
real_introspect = door.introspect

def observed_introspect(token):
    try:
        return real_introspect(token)
    except Exception as error:
        known = ('invalid introspection', 'invalid introspection binding', 'introspection unavailable', 'introspection deadline')
        reason = str(error) if str(error) in known else type(error).__name__
        sys.stderr.write('fixture real introspection refused: ' + reason + '\n')
        raise

door.introspect = observed_introspect
ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer((door.BIND, door.PORT), door.Door).serve_forever()
