import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from collector import bind, connect

HERE = Path(__file__).resolve().parent


class RepairSpoolTests(unittest.TestCase):
    def test_dry_run_changes_nothing_apply_requeues_and_a_running_collector_blocks_it(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'spool.sqlite'
            db = connect(state); bind(db, 'project', 'host')
            usage = [dict(requestId='r1', model='m', inputTokens=300000, cachedInputTokens=0, cacheWriteTokens=0, cacheWriteHourTokens=0, outputTokens=1, reasoningTokens=None),
                     dict(requestId='r2', model=None, inputTokens=1, cachedInputTokens=0, cacheWriteTokens=0, cacheWriteHourTokens=0, outputTokens=1, reasoningTokens=None)]
            db.execute('INSERT INTO turns(provider,native,turn_id,revision,acked,body) VALUES (?,?,?,?,?,?)',
                       ('codex', 'n', 't', 2, 2, json.dumps(dict(nativeTurnId='t', revision=2, usage=usage))))
            db.commit(); db.close()
            run = lambda *extra: subprocess.run([sys.executable, str(HERE / 'repair_spool.py'), '--state', str(state), *extra], capture_output=True, text=True)
            self.assertIn('Would requeue 1', run().stdout)
            check = connect(state)
            self.assertEqual(check.execute('SELECT acked FROM turns').fetchone()[0], 2); check.close()
            with state.with_suffix('.collector.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.assertIn('stop it before repairing', run('--apply').stderr)
            self.assertIn('Requeued 1', run('--apply').stdout)
            check = connect(state)
            acked, body = check.execute('SELECT acked,body FROM turns').fetchone(); check.close()
            turn = json.loads(body)
            self.assertEqual(acked, 0)
            self.assertEqual([(u['requestId'], u['fast'], u['longContext']) for u in turn['usage']], [('r1', False, True)])
            self.assertIs(turn['usageComplete'], False)


if __name__ == '__main__':
    unittest.main()
