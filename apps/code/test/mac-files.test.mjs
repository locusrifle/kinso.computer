// What Workbench does differently on a Mac, checked from any computer: the
// commands it would run there, and how it reads what they say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duCommand } from '../../../system/files.mjs';
import { MAC_TRASH, trashCommand, trashRefusal } from '../../../system/file-actions.mjs';
import { pictureMaking } from '../../../system/thumbnails.mjs';

test('the disk map asks a Mac\'s du in kilobytes on one disk, and Linux\'s in bytes', () => {
  assert.deepEqual(duCommand('/Users/noah', null, 'darwin'), { args: ['-x', '-k', '-d', '4', '/Users/noah'], scale: 1024 });
  assert.deepEqual(duCommand('/home/noah', null, 'linux'), { args: ['-x', '-B1', '-d', '4', '/home/noah'], scale: 1 });
  assert.deepEqual(duCommand('/', ['/boot', '/a*b'], 'linux').args, ['--exclude=/boot', '--exclude=/a\\*b', '-B1', '-d', '4', '/']);
});

test('the Trash on a Mac is Foundation\'s, the path an argument and never part of the script', () => {
  const [command, args] = trashCommand('/Users/noah/it\'s "here".txt', 'darwin');
  assert.equal(command, '/usr/bin/osascript');
  assert.deepEqual(args, ['-l', 'JavaScript', '-e', MAC_TRASH, '/Users/noah/it\'s "here".txt']);
  assert.match(MAC_TRASH, /trashItemAtURLResultingItemURLError/);
  assert.deepEqual(trashCommand('/home/noah/a', 'linux'), ['gio', ['trash', '--', '/home/noah/a']]);
});

test('what osascript says when the Trash refuses is said as a person would', () => {
  const said = message => trashRefusal({ stderr: `0:345: execution error: Error: ${message} (-2700)\n` });
  assert.equal(said('You don’t have permission to access “Library”.'), "you don't have permission");
  assert.equal(said('The file “a.txt” couldn’t be opened because there is no such file.'), "it isn't there any more");
  assert.equal(said('The volume “Untitled” doesn’t support the Trash.'), 'The volume “Untitled” doesn’t support the Trash.');
});

test('a Mac makes small pictures with sips, as JPEG', () => {
  const { makers, extension } = pictureMaking('darwin');
  assert.equal(extension, '.jpg');
  assert.deepEqual(makers[0]('/a.png', '/b.jpg'), ['/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '480', '/a.png', '--out', '/b.jpg']]);
  assert.equal(pictureMaking('linux').extension, '.webp');
});
