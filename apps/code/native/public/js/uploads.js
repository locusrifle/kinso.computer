// One byte transport for files, pictures and recordings. Commands send references.

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export function uploadPercent(loaded, total) {
	if (!(total > 0)) return '…';
	return `${Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)))}%`;
}

export function postUpload(file, { onProgress, signal, sessionId, tabId, instanceId, owner, servingOwner } = {}) {
	return new Promise((resolve, reject) => {
		if (!owner || !servingOwner) {
			reject(new Error('Execution owner required for upload'));
			return;
		}
		if (!file) {
			reject(new Error('no file'));
			return;
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			reject(new Error(`${file.name || 'file'} is larger than 1 GB`));
			return;
		}
		const xhr = new XMLHttpRequest();
		const fail = (error) => {
			signal?.removeEventListener('abort', onAbort);
			reject(error);
		};
		const onAbort = () => xhr.abort();
		if (signal) {
			if (signal.aborted) {
				const error = new Error('upload aborted');
				error.name = 'AbortError';
				reject(error);
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		xhr.open('POST', attachmentURL('upload', { owner, servingOwner }));
		xhr.timeout = 30 * 60 * 1000;
		xhr.ontimeout = () => fail(new Error('upload timed out; try again'));
		xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'file'));
		if (!sessionId && (!tabId || !instanceId)) {
			fail(new Error('no selected session'));
			return;
		}
		if (sessionId) xhr.setRequestHeader('X-Session-Id', sessionId);
		if (tabId) xhr.setRequestHeader('X-Tab-Id', tabId);
		if (instanceId) xhr.setRequestHeader('X-Instance-Id', instanceId);
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');
		xhr.upload.onprogress = event => {
			onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
		};
		xhr.onload = () => {
			signal?.removeEventListener('abort', onAbort);
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					const saved = JSON.parse(xhr.responseText);
					if (!saved.reference || typeof saved.reference.name !== 'string') throw new Error('update imperfect on the session computer before attaching; no attachment reference was returned');
					resolve(saved);
				} catch (error) { fail(error); }
				return;
			}
			fail(new Error(xhr.responseText || `upload failed (${xhr.status})`));
		};
		xhr.onerror = () => fail(new Error('upload failed'));
		xhr.onabort = () => {
			const error = new Error('upload aborted');
			error.name = 'AbortError';
			fail(error);
		};
		xhr.send(file);
	});
}

export function attachmentURL(action, { owner, servingOwner }) {
  if (!owner || !servingOwner) throw new Error('Execution owner required for attachment');
  return `${owner === servingOwner ? '' : `/peer/${encodeURIComponent(owner)}`}/${action}`;
}

export async function useUpload(action, body, target, { signal } = {}) {
  const res = await fetch(attachmentURL(action, target), { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || answer.accepted === false) throw new Error(answer.error || `${action} failed (${res.status})`);
  return answer;
}
