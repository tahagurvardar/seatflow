import {
  profileCapabilities,
  resolveDeploymentProfile,
} from "@/features/operations/deployment-profile";
import { describePaymentCapability } from "@/features/operations/production-check";

/**
 * Honest environment disclosure.
 *
 * A staging demo looks exactly like the real product — that is the point of it
 * — which is precisely why it must say what it is. Someone who reaches a
 * checkout page and enters what they believe is a payment has been misled, and
 * no amount of "it's obviously a demo" reasoning survives contact with a real
 * visitor who arrived from a link.
 *
 * So the banner is not decorative and is not dismissible. It states two things
 * plainly: that this is not production, and that payments are simulated. It
 * renders nothing at all in a real production deployment.
 */
export function EnvironmentBanner() {
  const profile = resolveDeploymentProfile(process.env);
  if (!profileCapabilities(profile).requiresDemoDisclosure) return null;

  const payments = describePaymentCapability(process.env);
  const isStaging = profile === "staging-demo";

  return (
    <div
      role="region"
      aria-label="Environment notice"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900"
    >
      <p className="mx-auto max-w-4xl">
        <span className="font-semibold uppercase tracking-wide">
          {isStaging ? "Demo environment" : "Development environment"}
        </span>
        <span aria-hidden="true"> · </span>
        {payments.summary}
        {isStaging ? (
          <>
            {" "}
            Bookings, tickets, and emails here are synthetic and may be removed
            at any time.
          </>
        ) : null}
      </p>
    </div>
  );
}
