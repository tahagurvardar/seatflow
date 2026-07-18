export class CheckoutAuthenticationError extends Error {
  constructor() {
    super("You must be signed in to check out.");
    this.name = "CheckoutAuthenticationError";
  }
}

export class CheckoutAuthorizationError extends Error {
  constructor(message = "That checkout was not found or is not yours.") {
    super(message);
    this.name = "CheckoutAuthorizationError";
  }
}

export class CheckoutEligibilityError extends Error {
  constructor(
    message: string,
    public readonly safeCode = "CHECKOUT_INELIGIBLE",
  ) {
    super(message);
    this.name = "CheckoutEligibilityError";
  }
}

export class CheckoutConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutConflictError";
  }
}

export class CheckoutValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues[0] ?? "That checkout request is invalid.");
    this.name = "CheckoutValidationError";
  }
}

export class PaymentProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderConfigurationError";
  }
}

export class PaymentProviderError extends Error {
  constructor(message = "The payment provider is temporarily unavailable.") {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export class PaymentWebhookSignatureError extends Error {
  constructor() {
    super("Payment webhook signature verification failed.");
    this.name = "PaymentWebhookSignatureError";
  }
}

export class PaymentWebhookValidationError extends Error {
  constructor(message = "Payment webhook payload is invalid.") {
    super(message);
    this.name = "PaymentWebhookValidationError";
  }
}

