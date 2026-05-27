# Epic-express

A modular Node.js/Express integration utility for Epic EHR (FHIR) workflows.

## Features

- OAuth2 client credentials authentication
- Patient resource reads (`Patient/{id}`)
- DocumentReference creation with:
  - direct attachment URL (`attachment.url`)
  - uploaded `Binary` resource references
- DocumentReference retrieval and attached asset download
- Express middleware helper to inject a reusable Epic client instance

## Install

```bash
npm install epic-express
```

## Usage

```js
const { EpicClient, createEpicClientMiddleware } = require('epic-express');

async function main() {
  const client = new EpicClient({
    baseUrl: 'https://your-epic-host/fhir/R4',
    clientId: process.env.EPIC_CLIENT_ID,
    clientSecret: process.env.EPIC_CLIENT_SECRET,
    scope: 'system/*.read system/*.write',
  });

  const patient = await client.getPatient('12345');

  await client.createDocumentReferenceWithBinary({
    patientId: '12345',
    contentType: 'application/pdf',
    data: Buffer.from('example'),
    title: 'Summary PDF',
  });

  await client.createDocumentReferenceWithUrl({
    patientId: '12345',
    contentType: 'application/pdf',
    url: 'https://storage.example.com/files/summary.pdf',
    title: 'External PDF',
  });

  const references = await client.searchDocumentReferences({ patientId: '12345' });
  const asset = await client.getDocumentReferenceAsset('doc-id');
}

main().catch(console.error);
```

### Express middleware

```js
const express = require('express');
const { createEpicClientMiddleware } = require('epic-express');

const app = express();
app.use(createEpicClientMiddleware({
  baseUrl: 'https://your-epic-host/fhir/R4',
  clientId: process.env.EPIC_CLIENT_ID,
  clientSecret: process.env.EPIC_CLIENT_SECRET,
}));

app.get('/patient/:id', async (req, res, next) => {
  try {
    const patient = await req.epic.getPatient(req.params.id);
    res.json(patient);
  } catch (err) {
    next(err);
  }
});
```
