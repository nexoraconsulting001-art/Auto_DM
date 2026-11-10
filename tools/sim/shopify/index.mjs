/**
 * Shopify Admin REST, base routes only: the app token exchange, the shop, and reading products and orders.
 * POST /__sim/products and POST /__sim/orders seed them. Later phases add writes and webhooks.
 */
import { SimError, createSim } from '../base.mjs';

const shopifyError = (status, errors) => new SimError(status, { errors });

export function createShopify({ token = 'sim-shopify-token', clientId = 'sim-shopify-client', clientSecret = 'sim-shopify-secret' } = {}) {
  let products;
  let orders;
  let seq;
  const clear = () => {
    products = [];
    orders = [];
    seq = 0;
  };
  clear();

  function requireToken(req) {
    if (req.headers['x-shopify-access-token'] !== token) throw shopifyError(401, '[API] Invalid API key or access token (unrecognized login or wrong password)');
  }

  return createSim({
    name: 'shopify',
    errorBody: ({ kind }) => ({ errors: `Simulated ${kind}.` }),
    reset: clear,
    routes: (on) => {
      on('POST', '/admin/oauth/access_token', (req) => {
        if (req.body?.client_id !== clientId || req.body?.client_secret !== clientSecret || !req.body?.code) throw shopifyError(400, 'invalid_request');
        return { access_token: token, scope: 'read_products,read_orders' };
      });
      on('GET', '/admin/api/:version/shop.json', (req) => {
        requireToken(req);
        return { shop: { id: 1, name: 'Simulated Shop', myshopify_domain: 'sim.myshopify.test', currency: 'INR' } };
      });
      on('GET', '/admin/api/:version/products.json', (req) => {
        requireToken(req);
        return { products };
      });
      on('GET', '/admin/api/:version/orders.json', (req) => {
        requireToken(req);
        return { orders };
      });
    },
    controls: (on) => {
      on('POST', '/products', ({ body }) => {
        const product = { id: ++seq, title: 'Simulated product', variants: [], ...body };
        products.push(product);
        return product;
      });
      on('POST', '/orders', ({ body }) => {
        const order = { id: ++seq, financial_status: 'paid', line_items: [], ...body };
        orders.push(order);
        return order;
      });
    },
  });
}
