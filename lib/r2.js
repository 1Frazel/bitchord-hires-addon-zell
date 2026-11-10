'use strict';

const crypto = require('crypto');

const DEFAULT_ACCOUNT_ID = '9320408c0a85e91646716a015a3f9b60';
const DEFAULT_ENDPOINT = `https://${DEFAULT_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function md5Base64(data) {
  return crypto.createHash('md5').update(data).digest('base64');
}

function uriEncode(str, encodeSlash = true) {
  let encoded = '';
  const bytes = Buffer.from(String(str), 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const ch = String.fromCharCode(b);
    if (
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      ch === '_' ||
      ch === '-' ||
      ch === '~' ||
      ch === '.'
    ) {
      encoded += ch;
    } else if (ch === '/' && !encodeSlash) {
      encoded += '/';
    } else {
      encoded += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return encoded;
}

function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso, // YYYYMMDDTHHMMSSZ
    dateStamp: iso.slice(0, 8), // YYYYMMDD
  };
}

function getSigningKey(secretAccessKey, dateStamp, region = 'auto', service = 's3') {
  const kDate = hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

class R2Client {
  constructor(options = {}) {
    this.updateConfig(options);
    this._corsConfiguredBuckets = new Set();
    this._discoveredBucket = null;
  }

  updateConfig(options = {}) {
    this.accountId = (
      options.accountId ||
      process.env.R2_ACCOUNT_ID ||
      DEFAULT_ACCOUNT_ID
    ).trim();

    const rawEndpoint = (
      options.endpoint ||
      process.env.R2_ENDPOINT ||
      `https://${this.accountId}.r2.cloudflarestorage.com` ||
      DEFAULT_ENDPOINT
    )
      .trim()
      .replace(/\/+$/, '');

    // Ensure endpoint is only origin (in case someone pasted a bucket path onto the endpoint)
    try {
      const parsed = new URL(rawEndpoint);
      this.endpoint = parsed.origin;
      this.host = parsed.host;
    } catch {
      this.endpoint = DEFAULT_ENDPOINT;
      this.host = `${DEFAULT_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    }

    this.accessKeyId = (options.accessKeyId ?? process.env.R2_ACCESS_KEY_ID ?? '').trim();
    this.secretAccessKey = (
      options.secretAccessKey ??
      process.env.R2_SECRET_ACCESS_KEY ??
      ''
    ).trim();
    this.bucketName = (options.bucketName ?? process.env.R2_BUCKET_NAME ?? '').trim();
    this.publicUrl = (options.publicUrl ?? process.env.R2_PUBLIC_URL ?? '')
      .trim()
      .replace(/\/+$/, '');
    this.region = 'auto';
  }

  isConfigured() {
    return Boolean(this.accessKeyId && this.secretAccessKey && this.endpoint);
  }

  getActiveBucket() {
    return this.bucketName || this._discoveredBucket || '';
  }

  /**
   * Build signed headers for an S3 REST request against Cloudflare R2
   */
  signRequest({ method, path, query = {}, headers = {}, payload = '' }) {
    const { amzDate, dateStamp } = formatAmzDate();
    const payloadBuf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(String(payload || ''), 'utf8');
    const payloadHash = sha256Hex(payloadBuf);

    const canonicalUri = uriEncode(path.startsWith('/') ? path : '/' + path, false);

    const sortedQueryKeys = Object.keys(query).sort();
    const canonicalQueryString = sortedQueryKeys
      .map((k) => {
        const v = query[k];
        return `${uriEncode(k, true)}=${uriEncode(v === null || v === undefined ? '' : String(v), true)}`;
      })
      .join('&');

    const finalHeaders = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
    };

    const lowerHeaders = {};
    for (const [k, v] of Object.entries(finalHeaders)) {
      if (v !== undefined && v !== null) {
        lowerHeaders[k.toLowerCase().trim()] = String(v).trim();
      }
    }

    const signedHeaderNames = Object.keys(lowerHeaders).sort();
    const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${lowerHeaders[k]}\n`).join('');
    const signedHeadersStr = signedHeaderNames.join(';');

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeadersStr,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    const requestHeaders = { ...finalHeaders, Authorization: authorization };
    const url = `${this.endpoint}${canonicalUri}${
      canonicalQueryString ? '?' + canonicalQueryString : ''
    }`;

    return { url, headers: requestHeaders };
  }

  /**
   * Generate a Presigned URL (for direct browser PUT uploads or BitChord GET streaming)
   */
  presignUrl({ method = 'GET', bucket, key, expiresIn = 21600, responseContentType = null }) {
    const targetBucket = bucket || this.getActiveBucket();
    if (!targetBucket) {
      throw new Error('R2 bucket name is not configured');
    }

    // If publicUrl is configured and this is a GET request, use public URL directly
    if (method.toUpperCase() === 'GET' && this.publicUrl) {
      const encodedKey = uriEncode(key.replace(/^\/+/, ''), false);
      return `${this.publicUrl}/${encodedKey}`;
    }

    const { amzDate, dateStamp } = formatAmzDate();
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const cleanKey = key.replace(/^\/+/, '');
    const canonicalUri = uriEncode(`/${targetBucket}/${cleanKey}`, false);

    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
    };

    if (responseContentType && method.toUpperCase() === 'GET') {
      query['response-content-type'] = responseContentType;
    }

    const sortedQueryKeys = Object.keys(query).sort();
    const canonicalQueryString = sortedQueryKeys
      .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
      .join('&');

    const canonicalHeaders = `host:${this.host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    return `${this.endpoint}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  /**
   * Perform a signed S3 HTTP request against Cloudflare R2
   */
  async request({ method = 'GET', path = '/', query = {}, headers = {}, body = null }) {
    if (!this.isConfigured()) {
      throw new Error(
        'Cloudflare R2 Access Key ID and Secret Access Key are not configured yet.'
      );
    }

    const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
    const { url, headers: signedHeaders } = this.signRequest({
      method,
      path,
      query,
      headers,
      payload,
    });

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: signedHeaders,
    };

    if (payload.length > 0 && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      fetchOptions.body = payload;
    }

    const response = await fetch(url, fetchOptions);
    return response;
  }

  /**
   * List buckets in the R2 account
   */
  async listBuckets() {
    const res = await this.request({ method: 'GET', path: '/' });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`R2 ListBuckets failed (HTTP ${res.status}): ${extractXmlMessage(text)}`);
    }
    const buckets = [];
    const regex = /<Bucket>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/Bucket>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      buckets.push(match[1].trim());
    }
    return buckets;
  }

  /**
   * Ensure a usable bucket exists (auto-discovers from R2 if R2_BUCKET_NAME is unset,
   * or creates it if possible)
   */
  async resolveBucket() {
    if (this.bucketName) {
      return this.bucketName;
    }
    if (this._discoveredBucket) {
      return this._discoveredBucket;
    }
    try {
      const buckets = await this.listBuckets();
      if (buckets.length > 0) {
        this._discoveredBucket = buckets[0];
        return this._discoveredBucket;
      }
      // Try creating default bucket "bitchord-hires"
      const defaultBucket = 'bitchord-hires';
      const createRes = await this.request({
        method: 'PUT',
        path: `/${defaultBucket}`,
      });
      if (createRes.ok || createRes.status === 409) {
        this._discoveredBucket = defaultBucket;
        return defaultBucket;
      }
    } catch {
      // Ignore if token is scoped to a single bucket and cannot call ListBuckets
    }
    return this.bucketName || 'bitchord-hires';
  }

  /**
   * Configure CORS on the R2 bucket so browser direct uploads (PUT) and Range streaming work
   */
  async configureBucketCors(bucketOverride = null) {
    const bucket = bucketOverride || (await this.resolveBucket());
    if (!bucket) throw new Error('No R2 bucket specified');

    const corsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      '  <CORSRule>',
      '    <AllowedOrigin>*</AllowedOrigin>',
      '    <AllowedMethod>GET</AllowedMethod>',
      '    <AllowedMethod>PUT</AllowedMethod>',
      '    <AllowedMethod>POST</AllowedMethod>',
      '    <AllowedMethod>HEAD</AllowedMethod>',
      '    <AllowedMethod>DELETE</AllowedMethod>',
      '    <AllowedHeader>*</AllowedHeader>',
      '    <ExposeHeader>ETag</ExposeHeader>',
      '    <ExposeHeader>Content-Length</ExposeHeader>',
      '    <ExposeHeader>Content-Range</ExposeHeader>',
      '    <ExposeHeader>Accept-Ranges</ExposeHeader>',
      '    <MaxAgeSeconds>86400</MaxAgeSeconds>',
      '  </CORSRule>',
      '</CORSConfiguration>',
    ].join('\n');

    const bodyBuf = Buffer.from(corsXml, 'utf8');
    const res = await this.request({
      method: 'PUT',
      path: `/${bucket}`,
      query: { cors: '' },
      headers: {
        'Content-Type': 'application/xml',
        'Content-MD5': md5Base64(bodyBuf),
      },
      body: bodyBuf,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Failed to auto-configure R2 CORS (HTTP ${res.status}): ${extractXmlMessage(errText)}`
      );
    }

    this._corsConfiguredBuckets.add(bucket);
    return true;
  }

  async ensureCorsOnce() {
    const bucket = await this.resolveBucket();
    if (!bucket || this._corsConfiguredBuckets.has(bucket)) return;
    try {
      await this.configureBucketCors(bucket);
    } catch {
      // Non-fatal if token does not have PutBucketCors permission
    }
  }

  async getObjectJson(key) {
    const bucket = await this.resolveBucket();
    const cleanKey = key.replace(/^\/+/, '');
    const res = await this.request({
      method: 'GET',
      path: `/${bucket}/${cleanKey}`,
    });
    if (res.status === 404) {
      return null;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`R2 GET ${cleanKey} failed (HTTP ${res.status}): ${extractXmlMessage(text)}`);
    }
    return JSON.parse(text);
  }

  async putObjectJson(key, data) {
    const bucket = await this.resolveBucket();
    const cleanKey = key.replace(/^\/+/, '');
    const bodyBuf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    const res = await this.request({
      method: 'PUT',
      path: `/${bucket}/${cleanKey}`,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: bodyBuf,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 PUT ${cleanKey} failed (HTTP ${res.status}): ${extractXmlMessage(text)}`);
    }
    return true;
  }

  async putObjectBuffer(key, buffer, contentType = 'application/octet-stream') {
    const bucket = await this.resolveBucket();
    const cleanKey = key.replace(/^\/+/, '');
    const bodyBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const res = await this.request({
      method: 'PUT',
      path: `/${bucket}/${cleanKey}`,
      headers: {
        'Content-Type': contentType,
      },
      body: bodyBuf,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 PUT ${cleanKey} failed (HTTP ${res.status}): ${extractXmlMessage(text)}`);
    }
    return { bucket, key: cleanKey };
  }

  async deleteObject(key) {
    if (!key) return false;
    const bucket = await this.resolveBucket();
    const cleanKey = key.replace(/^\/+/, '');
    const res = await this.request({
      method: 'DELETE',
      path: `/${bucket}/${cleanKey}`,
    });
    return res.ok || res.status === 204 || res.status === 404;
  }
}

function extractXmlMessage(xml = '') {
  const codeMatch = /<Code>([^<]+)<\/Code>/.exec(xml);
  const msgMatch = /<Message>([^<]+)<\/Message>/.exec(xml);
  if (codeMatch && msgMatch) return `${codeMatch[1]}: ${msgMatch[1]}`;
  if (msgMatch) return msgMatch[1];
  return xml.slice(0, 200);
}

const r2 = new R2Client();

module.exports = {
  R2Client,
  r2,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ENDPOINT,
};
