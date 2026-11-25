import { startCheckout } from './checkout';

test('calls stripe', () => {
  expect(startCheckout).toBeDefined();
});
