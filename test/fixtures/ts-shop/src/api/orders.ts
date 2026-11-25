export const listOrders = () => fetch('/api/orders').then((r) => r.json());
