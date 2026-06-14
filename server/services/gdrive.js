const { google } = require('googleapis');
const { Readable } = require('stream');

// ── AUTH ──────────────────────────────────────────────────────
let _auth;
function getAuth() {
  if (_auth) return _auth;
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../credentials.json');
  _auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return _auth;
}

function drive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ── CONFIG ────────────────────────────────────────────────────
const ROOT_FOLDER_ID  = process.env.DRIVE_ROOT_FOLDER_ID;
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || null;

if (!ROOT_FOLDER_ID) {
  throw new Error('DRIVE_ROOT_FOLDER_ID env var não configurada');
}

// params extras necessários para Shared Drive
const sharedDriveListParams = SHARED_DRIVE_ID
  ? { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'drive', driveId: SHARED_DRIVE_ID }
  : {};
const sharedDriveWriteParams = SHARED_DRIVE_ID
  ? { supportsAllDrives: true }
  : {};

// ── CACHE DE PASTAS (in-memory) ───────────────────────────────
// evita chamadas repetidas de list/create para a mesma pasta
const _folderCache = new Map();

async function ensureFolder(name, parentId) {
  const cacheKey = `${parentId}:${name}`;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const d = drive();

  // tenta achar a pasta existente
  const res = await d.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
    ...sharedDriveListParams,
  });

  let folderId;
  if (res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    // cria a pasta
    const created = await d.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      ...sharedDriveWriteParams,
    });
    folderId = created.data.id;
  }

  _folderCache.set(cacheKey, folderId);
  return folderId;
}

// ── UPLOAD ────────────────────────────────────────────────────
/**
 * Faz upload de um Buffer para o Google Drive.
 * Estrutura de pastas: ROOT / reqCode / regionId / {timestamp}_{random}.{ext}
 *
 * @returns {{ url: string, fileId: string, mimeType: string }}
 */
async function uploadFile(buffer, mimeType, originalName, reqCode, regionId) {
  const d = drive();

  // garante estrutura de pastas
  const reqFolder    = await ensureFolder(reqCode, ROOT_FOLDER_ID);
  const regionFolder = await ensureFolder(regionId, reqFolder);

  const ext      = originalName.includes('.') ? '.' + originalName.split('.').pop().toLowerCase() : '';
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;

  // upload do arquivo
  const uploaded = await d.files.create({
    requestBody: {
      name: filename,
      parents: [regionFolder],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id',
    ...sharedDriveWriteParams,
  });

  const fileId = uploaded.data.id;

  // torna o arquivo público (leitura com o link)
  await d.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: !!SHARED_DRIVE_ID,
  });

  // URL: imagem → inline embed; PDF → viewer do Drive
  const isImage = mimeType.startsWith('image/');
  const url = isImage
    ? `https://drive.google.com/uc?export=view&id=${fileId}`
    : `https://drive.google.com/file/d/${fileId}/view`;

  return { url, fileId, mimeType };
}

module.exports = { uploadFile };
