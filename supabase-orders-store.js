const { SupabaseRestClient } = require('./supabase-rest-client');

class SupabaseOrdersStore {
  constructor() {
    this.client = null;
  }

  async initialize() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the server.');
    }

    this.client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
    await this.client.request('orders', { query: { select: 'id', limit: '1' } });

    await this.clearCancelledOrders();
  }

  getClient() {
    if (!this.client) {
      throw new Error('The Supabase orders store has not been initialized.');
    }

    return this.client;
  }

  async listOrders() {
    const client = this.getClient();
    const orders = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const data = await client.request('orders', {
        query: {
          select: '*',
          order: 'id.desc',
          limit: String(pageSize),
          offset: String(offset),
        },
      });

      orders.push(...data);
      if (data.length < pageSize) {
        return orders;
      }

      offset += pageSize;
    }
  }

  async createOrder(order) {
    const data = await this.getClient().request('orders', {
      method: 'POST',
      query: { select: 'id' },
      prefer: 'return=representation',
      body: {
        customer_name: order.customerName,
        email: order.email,
        phone: order.phone,
        address: order.address,
        product: order.product,
        size: order.size,
        quantity: order.quantity,
        total: order.total,
      },
    });

    return data[0].id;
  }

  async deleteOrderById(id) {
    await this.getClient().request('orders', {
      method: 'DELETE',
      query: { id: `eq.${Number(id)}` },
    });
  }

  async clearCancelledOrders() {
    await this.getClient().request('orders', {
      method: 'DELETE',
      query: { status: 'ilike.cancelled' },
    });
  }

  async updateOrderStatus(id, status) {
    await this.getClient().request('orders', {
      method: 'PATCH',
      query: { id: `eq.${Number(id)}` },
      body: { status },
    });
  }
}

module.exports = { SupabaseOrdersStore };
