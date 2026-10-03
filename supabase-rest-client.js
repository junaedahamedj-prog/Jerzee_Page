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

    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        : `Supabase returned HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = typeof data === 'object' ? data?.code : undefined;
      throw error;
    }

    return data;
  }
}

module.exports = { SupabaseRestClient };
