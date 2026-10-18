const { SupabaseRestClient } = require('./supabase-rest-client');

class SupabaseOrdersStore {
  constructor() {
    this.client = null;
  }

  async initialize() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      const error = new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Vercel project settings.');
      error.code = 'SUPABASE_NOT_CONFIGURED';
      throw error;
    }

    this.client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
    await this.client.request('orders', { query: { select: 'id', limit: '1' } });
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

  async getOrderById(id) {
    const orders = await this.getClient().request('orders', {
      query: {
        select: '*',
        id: `eq.${Number(id)}`,
        limit: '1',
      },
    });
    return orders[0] || null;
  }

  async listInventory() {
    return this.getClient().request('inventory_stock', {
      query: {
        select: 'product_id,size,available_quantity,low_stock_threshold,updated_at',
        order: 'product_id.asc,size.asc',
      },
    });
  }

  async setInventoryStock(productId, size, quantity) {
    const data = await this.getClient().request('rpc/set_inventory_stock', {
      method: 'POST',
      body: {
        p_product_id: productId,
        p_size: size,
        p_quantity: quantity,
      },
    });
    return Array.isArray(data) ? data[0] || null : data;
  }

  async createOrder(order) {
    const orderIds = await this.createOrders([order]);
    return orderIds[0];
  }

  async createOrders(orders) {
    const data = await this.getClient().request('orders', {
      method: 'POST',
      query: { select: 'id' },
      prefer: 'return=representation',
      body: orders.map((order) => ({
        customer_name: order.customerName,
        email: order.email,
        phone: order.phone,
        address: order.address,
        product: order.product,
        size: order.size,
        quantity: order.quantity,
        total: order.total,
        status: order.status,
      })),
    });

    return data.map((order) => order.id);
  }

  async createInventoryOrders(customer, orders) {
    const data = await this.getClient().request('rpc/create_inventory_orders', {
      method: 'POST',
      body: {
        p_customer_name: customer.customerName,
        p_email: customer.email,
        p_phone: customer.phone,
        p_address: customer.address,
        p_items: orders.map((order) => ({
          productId: order.productId,
          product: order.product,
          size: order.size,
          quantity: order.quantity,
          total: order.total,
        })),
      },
    });
    const result = Array.isArray(data) ? data[0] : data;
    const orderIds = result?.orderIds;
    if (!Array.isArray(orderIds)) {
      throw new Error('Supabase did not return the newly created inventory order IDs.');
    }
    return orderIds;
  }

  async deleteOrderById(id) {
    await this.getClient().request('orders', {
      method: 'DELETE',
      query: { id: `eq.${Number(id)}` },
    });
  }

  async updateOrderStatus(id, status) {
    await this.getClient().request('orders', {
      method: 'PATCH',
      query: { id: `eq.${Number(id)}` },
      body: { status },
    });
  }

  async updatePendingOrder(id, updates) {
    const data = await this.getClient().request('orders', {
      method: 'PATCH',
      query: {
        id: `eq.${id}`,
        status: 'eq.Pending Confirmation',
        select: 'id',
      },
      prefer: 'return=representation',
      body: updates,
    });

    return Array.isArray(data) && data.length > 0;
  }

  async updatePendingInventoryOrder(id, updates, productId) {
    const data = await this.getClient().request('rpc/update_pending_inventory_order', {
      method: 'POST',
      body: {
        p_order_id: Number(id),
        p_quantity: updates.quantity,
        p_total: updates.total,
        p_product_id: productId,
        p_target_status: updates.status || 'Pending Confirmation',
      },
    });
    return Array.isArray(data) ? data[0] || { updated: false } : data;
  }

  async cancelPendingInventoryOrder(id) {
    const data = await this.getClient().request('rpc/cancel_pending_inventory_order', {
      method: 'POST',
      body: { p_order_id: Number(id) },
    });
    return Array.isArray(data) ? data[0] || { updated: false } : data;
  }
}

module.exports = { SupabaseOrdersStore };
