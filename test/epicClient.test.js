const test = require('node:test');
const assert = require('node:assert/strict');

const { EpicApiError, EpicClient } = require('../src');

function createFetchStub(handlers) {
  return async (url, options = {}) => {
    for (const handler of handlers) {
      const result = await handler(url, options);
      if (result) return result;
    }

    throw new Error(`Unhandled request: ${options.method || 'GET'} ${url}`);
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

test('authenticates then reads a patient', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
    },
    (url, options) => {
      if (url.endsWith('/Patient/123')) {
        assert.ok(options.headers.authorization.startsWith('Bearer '));
        assert.ok(options.headers.authorization.endsWith('token-1'));
        return jsonResponse({ resourceType: 'Patient', id: '123' });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const patient = await client.getPatient('123');
  assert.equal(patient.id, '123');
});

test('creates DocumentReference from binary upload flow', async () => {
  const requests = [];
  const fetch = createFetchStub([
    (url, options) => {
      requests.push([url, options]);
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
      if (url.endsWith('/Binary')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.resourceType, 'Binary');
        assert.equal(payload.contentType, 'application/pdf');
        return jsonResponse({ resourceType: 'Binary', id: 'bin-1' }, 201);
      }
      if (url.endsWith('/DocumentReference')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.subject.reference, 'Patient/p1');
        assert.equal(payload.content[0].attachment.url, 'Binary/bin-1');
        return jsonResponse({ resourceType: 'DocumentReference', id: 'doc-1' }, 201);
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const doc = await client.createDocumentReferenceWithBinary({
    patientId: 'p1',
    contentType: 'application/pdf',
    data: Buffer.from('sample-pdf'),
  });

  assert.equal(doc.id, 'doc-1');
  assert.equal(requests.filter(([url]) => url.endsWith('/oauth2/token')).length, 1);
});

test('normalizes Buffer attachment.data to base64 when creating DocumentReference', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
    },
    (url, options) => {
      if (url.endsWith('/DocumentReference')) {
        const payload = JSON.parse(options.body);
        assert.equal(
          payload.content[0].attachment.data,
          Buffer.from('sample-document').toString('base64'),
        );
        return jsonResponse({ resourceType: 'DocumentReference', id: 'doc-buffer' }, 201);
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const doc = await client.createDocumentReference({
    patientId: 'p1',
    attachments: [{
      contentType: 'text/plain',
      data: Buffer.from('sample-document'),
      title: 'Buffered data',
    }],
  });

  assert.equal(doc.id, 'doc-buffer');
});

test('rejects non-string non-buffer attachment.data values', async () => {
  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    },
  });

  await assert.rejects(
    () => client.createDocumentReference({
      patientId: 'p1',
      attachments: [{
        contentType: 'text/plain',
        data: { invalid: true },
      }],
    }),
    /attachment\.data must be a base64 string or Buffer/,
  );
});

test('retrieves existing DocumentReference attachment by URL', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
    },
    (url, options) => {
      if (url.endsWith('/DocumentReference/doc-1')) {
        assert.ok(options.headers.authorization.startsWith('Bearer '));
        assert.ok(options.headers.authorization.endsWith('token-1'));
        return jsonResponse({
          resourceType: 'DocumentReference',
          id: 'doc-1',
          content: [{ attachment: { url: 'Binary/bin-2', contentType: 'application/pdf' } }],
        });
      }
    },
    (url, options) => {
      if (url.endsWith('/Binary/bin-2')) {
        assert.ok(options.headers.authorization.startsWith('Bearer '));
        assert.ok(options.headers.authorization.endsWith('token-1'));
        return new Response(Buffer.from('pdf-binary-data'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const asset = await client.getDocumentReferenceAsset('doc-1');
  assert.equal(asset.contentType, 'application/pdf');
  assert.equal(asset.data.toString(), 'pdf-binary-data');
});

test('reuses token when expires_in is smaller than default refresh buffer', async () => {
  let tokenCalls = 0;
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        tokenCalls += 1;
        return jsonResponse({ access_token: 'token-1', expires_in: 10 });
      }
    },
    (url) => {
      if (url.endsWith('/Patient/123')) {
        return jsonResponse({ resourceType: 'Patient', id: '123' });
      }
      if (url.endsWith('/Patient/124')) {
        return jsonResponse({ resourceType: 'Patient', id: '124' });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  await client.getPatient('123');
  await client.getPatient('124');

  assert.equal(tokenCalls, 1);
});

test('uses OAuth token_type in authorization header', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-1', token_type: 'Epic', expires_in: 3600 });
      }
    },
    (url, options) => {
      if (url.endsWith('/Patient/123')) {
        assert.equal(options.headers.authorization, 'Epic token-1');
        return jsonResponse({ resourceType: 'Patient', id: '123' });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const patient = await client.getPatient('123');
  assert.equal(patient.id, '123');
});

test('authenticates with best-effort JSON parsing when content-type is not JSON', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return new Response('{"access_token":"token-1","expires_in":3600}', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
    },
    (url, options) => {
      if (url.endsWith('/Patient/123')) {
        assert.ok(options.headers.authorization.startsWith('Bearer '));
        assert.ok(options.headers.authorization.endsWith('token-1'));
        return jsonResponse({ resourceType: 'Patient', id: '123' });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const patient = await client.getPatient('123');
  assert.equal(patient.id, '123');
});

test('surfaces non-JSON OAuth error bodies without masking HTTP details', async () => {
  const fetch = createFetchStub([
    (url) => {
      if (url.endsWith('/oauth2/token')) {
        return new Response('invalid_client', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  await assert.rejects(
    () => client.getAccessToken(),
    (error) => {
      assert.ok(error instanceof EpicApiError);
      assert.equal(error.status, 401);
      assert.equal(error.body, 'invalid_client');
      return true;
    },
  );
});

test('shares in-flight authentication across concurrent requests', async () => {
  let tokenCalls = 0;
  let releaseTokenResponse;
  const tokenResponseReady = new Promise((resolve) => {
    releaseTokenResponse = resolve;
  });

  const fetch = createFetchStub([
    async (url) => {
      if (url.endsWith('/oauth2/token')) {
        tokenCalls += 1;
        await tokenResponseReady;
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
    },
    (url) => {
      if (url.endsWith('/Patient/123')) {
        return jsonResponse({ resourceType: 'Patient', id: '123' });
      }
      if (url.endsWith('/Patient/124')) {
        return jsonResponse({ resourceType: 'Patient', id: '124' });
      }
    },
  ]);

  const client = new EpicClient({
    baseUrl: 'https://ehr.example.com/fhir/R4',
    clientId: 'abc',
    clientSecret: 'def',
    fetchImpl: fetch,
  });

  const patient1Promise = client.getPatient('123');
  const patient2Promise = client.getPatient('124');
  releaseTokenResponse();

  const [patient1, patient2] = await Promise.all([patient1Promise, patient2Promise]);
  assert.equal(patient1.id, '123');
  assert.equal(patient2.id, '124');
  assert.equal(tokenCalls, 1);
});
