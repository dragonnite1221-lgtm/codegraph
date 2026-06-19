/**
 * Shared sample-codebase fixture for the Context Builder tests. Builds a small
 * payment/checkout/utils project, indexes it, and returns the instance. Split
 * out of context.test.ts so both context test files share one setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

export interface ContextProject {
  testDir: string;
  cg: CodeGraph;
}

/** Create + index the sample project. */
export async function createContextProject(): Promise<ContextProject> {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-test-'));

  // Create a sample codebase
  const srcDir = path.join(testDir, 'src');
  fs.mkdirSync(srcDir);

  // Create a payment service file
  fs.writeFileSync(
    path.join(srcDir, 'payment.ts'),
    `/**
 * Payment Service
 * Handles payment processing logic.
 */

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  amount: number;
}

export class PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Process a payment for the given amount
   */
  async processPayment(amount: number): Promise<PaymentResult> {
    // Validate amount
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    // Process payment
    const transactionId = this.generateTransactionId();
    return {
      success: true,
      transactionId,
      amount,
    };
  }

  private generateTransactionId(): string {
    return 'txn_' + Math.random().toString(36).substring(2);
  }
}

export function createPaymentService(apiKey: string): PaymentService {
  return new PaymentService(apiKey);
}
`
  );

  // Create a checkout controller file
  fs.writeFileSync(
    path.join(srcDir, 'checkout.ts'),
    `/**
 * Checkout Controller
 * Handles the checkout flow.
 */

import { PaymentService, PaymentResult } from './payment';

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export class CheckoutController {
  private paymentService: PaymentService;

  constructor(paymentService: PaymentService) {
    this.paymentService = paymentService;
  }

  /**
   * Process checkout for the given cart
   */
  async processCheckout(cart: CartItem[]): Promise<PaymentResult> {
    const total = this.calculateTotal(cart);

    if (total === 0) {
      throw new Error('Cart is empty');
    }

    return this.paymentService.processPayment(total);
  }

  /**
   * Calculate the total price of the cart
   */
  calculateTotal(cart: CartItem[]): number {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`
  );

  // Create a utilities file
  fs.writeFileSync(
    path.join(srcDir, 'utils.ts'),
    `/**
 * Utility functions
 */

export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`
  );

  // Initialize CodeGraph
  const cg = CodeGraph.initSync(testDir, {
    config: {
      include: ['**/*.ts'],
      exclude: [],
    },
  });

  // Index the codebase
  await cg.indexAll();

  return { testDir, cg };
}

/** Tear down a project created by createContextProject. */
export function cleanupContextProject(testDir: string, cg: CodeGraph | undefined): void {
  if (cg) {
    cg.destroy();
  }
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
