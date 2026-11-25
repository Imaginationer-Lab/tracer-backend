import axios from 'axios';

export const shippingApi = axios.create({ baseURL: 'https://api.shipping-partner.kr', timeout: 5000 });
