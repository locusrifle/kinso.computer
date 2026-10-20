#!/usr/bin/env python3
"""Run on laptop, in its own user unit. Numeric process data and profile messages only."""
import argparse
import json
import os
import subprocess
import threading
import time

p = argparse.ArgumentParser()
p.add_argument('--seconds', type=int, default=600)
p.add_argument('--out', required=True)
a = p.parse_args()
os.makedirs(a.out, mode=0o700, exist_ok=True)
stop = threading.Event()
log = open(os.path.join(a.out, 'native.jsonl'), 'w', buffering=1)
mutex = threading.Lock()

def emit(data):
    with mutex:
        log.write(json.dumps(data) + '\n')

journal = subprocess.Popen(['journalctl', '--user', '-f', '-n', '0', '-o', 'json'], stdout=subprocess.PIPE, text=True)

def follow():
    for line in journal.stdout:
        try:
            row = json.loads(line)
            msg = row.get('MESSAGE', '')
            prefix = 'imperfect-locker: profile:'
            if not msg.startswith(prefix):
                continue
            data = json.loads(msg[len(prefix):])
            emit({'type': 'profile', 'pid': row.get('_PID'), 'journalMonoUs': row.get('__MONOTONIC_TIMESTAMP'), 'data': data})
        except (ValueError, TypeError):
            continue

thread = threading.Thread(target=follow, daemon=True)
thread.start()
hz = os.sysconf('SC_CLK_TCK')
previous = {}
start = time.monotonic()
emit({'type': 'collector-start', 'monoMs': start * 1000, 'hz': hz, 'intervalMs': 250})
try:
    while time.monotonic() - start < a.seconds:
        now = time.monotonic()
        current = {}
        for pid in os.listdir('/proc'):
            if not pid.isdigit():
                continue
            try:
                root = '/proc/' + pid
                if os.stat(root).st_uid != os.getuid():
                    continue
                raw = open(root + '/stat').read()
                end = raw.rfind(')')
                comm = raw[raw.index('(') + 1:end]
                # Read only to identify the locker; never save arguments (may contain secrets).
                is_locker = comm.startswith('python') and b'imperfect-locker' in open(root + '/cmdline', 'rb').read()
                if not is_locker and not comm.startswith(('WebKit', 'electron', 'imperfect', 'sway', 'node', 'foot')):
                    continue
                stat = raw[end + 2:].split()
                ticks = int(stat[11]) + int(stat[12])
                born = int(stat[19])
                rss = int(stat[21]) * os.sysconf('SC_PAGE_SIZE')
                key = (pid, born)
                old = previous.get(key)
                cpu = 100 * (ticks - old[0]) / hz / (now - old[1]) if old else None
                current[key] = (ticks, now)
                emit({'type': 'process', 'monoMs': now * 1000, 'pid': int(pid), 'ppid': int(stat[1]), 'name': 'locker' if is_locker else comm, 'cpuPercent': cpu, 'rssBytes': rss, 'startTicks': born})
            except (OSError, ValueError, IndexError):
                continue
        previous = current
        time.sleep(.25)
finally:
    journal.terminate()
    journal.wait(timeout=5)
    thread.join(timeout=2)
    emit({'type': 'collector-end', 'monoMs': time.monotonic() * 1000})
    log.close()
