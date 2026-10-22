class SupabaseRestClient {
  constructor(url, serviceRoleKey) {
    if (!url || !serviceRoleKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before using Supabase.');
    }

    this.baseUrl = new URL(url);
    this.serviceRoleKey = serviceRoleKey;
  }

  async request(resource, { method = 'GET', query = {}, body, prefer } = {}) {
    const url = new URL(`/rest/v1/${resource}`, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

    const headers = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (prefer) {
      headers.Prefer = prefer;
    }

    const maxAttempts = method === 'GET' ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        continue;
      }

      const responseText = await response.text();
      let data = null;

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = responseText;
        }
      }

      if (!response.ok) {
        const isTransient = response.status === 408 || response.status === 429 ||
          response.status >= 500;
        if (method === 'GET' && isTransient && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          continue;
        }

        const message = typeof data === 'object' && data?.message
          ? data.message
          : `Supabase returned HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.code = typeof data === 'object' ? data?.code : undefined;
        error.resource = resource;
        throw error;
      }

      return data;
    }
  }

  async requestStorage(resource, { method = 'POST', body, contentType = 'application/json' } = {}) {
    const url = new URL(`/storage/v1/${resource}`, this.baseUrl);
    const headers = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
    };
    if (contentType) headers['Content-Type'] = contentType;

    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : {
        body: Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
      }),
    });
    const responseText = await response.text();
    let data = null;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }
    }
    if (!response.ok) {
      const message = typeof data === 'object' && data?.message
        ? data.message
        : `Supabase Storage returned HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = typeof data === 'object' ? data?.statusCode || data?.error : undefined;
      error.resource = `storage/${resource}`;
      throw error;
    }
    return data;
  }
}

module.exports = { SupabaseRestClient };
