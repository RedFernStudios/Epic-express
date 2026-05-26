const { Buffer } = require('node:buffer');
const TOKEN_REFRESH_BUFFER_MS = 15000;
const DEFAULT_TOKEN_EXPIRY_SECONDS = 300;

class EpicApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'EpicApiError';
    this.status = status;
    this.body = body;
  }
}

class EpicClient {
  constructor({
    baseUrl,
    clientId,
    clientSecret,
    tokenUrl,
    scope,
    fetchImpl = globalThis.fetch,
  }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!clientId) throw new Error('clientId is required');
    if (!clientSecret) throw new Error('clientSecret is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenUrl = tokenUrl || `${this.baseUrl}/oauth2/token`;
    this.scope = scope;
    this.fetch = fetchImpl;
    this.token = null;
    this.authPromise = null;
  }

  async authenticate({ scope = this.scope } = {}) {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    if (scope) body.set('scope', scope);

    const response = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const contentType = response.headers.get('content-type') || '';
    const rawTokenBody = await response.text();
    let tokenBody = rawTokenBody;

    if (rawTokenBody) {
      const shouldAttemptJsonParse = contentType.includes('application/json')
        || /^[\s]*[\[{]/.test(rawTokenBody);

      if (shouldAttemptJsonParse) {
        try {
          tokenBody = JSON.parse(rawTokenBody);
        } catch {
          tokenBody = rawTokenBody;
        }
      }
    }

    if (!response.ok) {
      throw new EpicApiError('OAuth2 authentication failed', {
        status: response.status,
        body: tokenBody,
      });
    }

    const isPlainTokenBody = tokenBody && typeof tokenBody === 'object' && !Array.isArray(tokenBody);
    if (!isPlainTokenBody) {
      throw new EpicApiError('OAuth2 authentication response was not valid JSON', {
        status: response.status,
        body: tokenBody,
      });
    }

    const now = Date.now();
    const expiresInSeconds = Number(tokenBody.expires_in);
    const expiresInMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds * 1000
      : DEFAULT_TOKEN_EXPIRY_SECONDS * 1000;
    const refreshBufferMs = Math.min(TOKEN_REFRESH_BUFFER_MS, Math.floor(expiresInMs / 2));

    this.token = {
      accessToken: tokenBody.access_token,
      tokenType: tokenBody.token_type || 'Bearer',
      expiresAt: now + Math.max(expiresInMs - refreshBufferMs, 0),
    };

    return this.token;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.token && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }

    if (!this.authPromise) {
      this.authPromise = this.authenticate()
        .finally(() => {
          this.authPromise = null;
        });
    }

    const token = await this.authPromise;
    return token.accessToken;
  }

  buildAuthorizationHeader(token, tokenType = 'Bearer') {
    return `${tokenType} ${token}`;
  }

  resolveUrl(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${this.baseUrl}${path}`;
  }

  async request(pathOrUrl, { method = 'GET', headers = {}, body, auth = true } = {}) {
    const url = this.resolveUrl(pathOrUrl);
    const requestHeaders = { ...headers };

    if (auth) {
      const token = await this.getAccessToken();
      requestHeaders.authorization = this.buildAuthorizationHeader(token, this.token.tokenType);
    }

    let requestBody = body;
    if (body && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams) && typeof body === 'object') {
      requestBody = JSON.stringify(body);
      if (!requestHeaders['content-type']) {
        requestHeaders['content-type'] = 'application/json';
      }
    }

    const response = await this.fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
    });

    const contentType = response.headers.get('content-type') || '';
    const responseBody = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new EpicApiError('Epic request failed', {
        status: response.status,
        body: responseBody,
      });
    }

    return responseBody;
  }

  async getPatient(patientId) {
    if (!patientId) throw new Error('patientId is required');
    return this.request(`/Patient/${patientId}`);
  }

  async createBinary({ contentType, data }) {
    if (!contentType) throw new Error('contentType is required');
    if (!data) throw new Error('data is required');

    const payload = {
      resourceType: 'Binary',
      contentType,
      data: Buffer.isBuffer(data) ? data.toString('base64') : data,
    };

    return this.request('/Binary', { method: 'POST', body: payload });
  }

  async createDocumentReference({
    patientId,
    status = 'current',
    type,
    description,
    date,
    attachments = [],
  }) {
    if (!patientId) throw new Error('patientId is required');
    if (!attachments.length) throw new Error('at least one attachment is required');

    const content = attachments.map((attachment) => {
      if (!attachment.contentType) throw new Error('attachment.contentType is required');
      if (!attachment.data && !attachment.url) {
        throw new Error('attachment.data or attachment.url is required');
      }

      return {
        attachment: {
          contentType: attachment.contentType,
          data: attachment.data,
          url: attachment.url,
          title: attachment.title,
        },
      };
    });

    const payload = {
      resourceType: 'DocumentReference',
      status,
      subject: { reference: `Patient/${patientId}` },
      content,
    };

    if (type) payload.type = type;
    if (description) payload.description = description;
    if (date) payload.date = date;

    return this.request('/DocumentReference', { method: 'POST', body: payload });
  }

  async createDocumentReferenceWithBinary({
    patientId,
    contentType,
    data,
    title,
    status,
    type,
    description,
    date,
  }) {
    const binary = await this.createBinary({ contentType, data });
    if (!binary.id) throw new Error('Binary response did not include id');

    return this.createDocumentReference({
      patientId,
      status,
      type,
      description,
      date,
      attachments: [{
        contentType,
        url: `Binary/${binary.id}`,
        title,
      }],
    });
  }

  async createDocumentReferenceWithUrl({
    patientId,
    contentType,
    url,
    title,
    status,
    type,
    description,
    date,
  }) {
    return this.createDocumentReference({
      patientId,
      status,
      type,
      description,
      date,
      attachments: [{ contentType, url, title }],
    });
  }

  async getDocumentReference(documentReferenceId) {
    if (!documentReferenceId) throw new Error('documentReferenceId is required');
    return this.request(`/DocumentReference/${documentReferenceId}`);
  }

  async searchDocumentReferences({ patientId }) {
    if (!patientId) throw new Error('patientId is required');
    return this.request(`/DocumentReference?subject=Patient/${encodeURIComponent(patientId)}`);
  }

  async getDocumentReferenceAsset(documentReferenceOrId, attachmentIndex = 0) {
    const documentReference = typeof documentReferenceOrId === 'string'
      ? await this.getDocumentReference(documentReferenceOrId)
      : documentReferenceOrId;

    const content = documentReference?.content?.[attachmentIndex]?.attachment;
    if (!content) throw new Error('attachment not found');

    if (content.data) {
      return {
        contentType: content.contentType,
        data: Buffer.from(content.data, 'base64'),
        source: 'inline',
      };
    }

    if (!content.url) throw new Error('attachment URL not found');

    const url = this.resolveUrl(content.url);
    const headers = {};

    if (url.startsWith(this.baseUrl)) {
      const token = await this.getAccessToken();
      headers.authorization = this.buildAuthorizationHeader(token);
    }

    const response = await this.fetch(url, { headers });
    if (!response.ok) {
      throw new EpicApiError('DocumentReference asset retrieval failed', {
        status: response.status,
        body: await response.text(),
      });
    }

    return {
      contentType: response.headers.get('content-type') || content.contentType,
      data: Buffer.from(await response.arrayBuffer()),
      source: 'url',
      url,
    };
  }
}

module.exports = {
  EpicClient,
  EpicApiError,
};
