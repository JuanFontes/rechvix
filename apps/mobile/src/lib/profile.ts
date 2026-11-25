import { DEFAULT_PROFILE, type Org, type Profile } from "../db/repo";

/** The business details a phone starts with when it signs in to a server before it has any of its own: taken from the server's company, so
 *  invoices already carry the right name, country, currency and GST state. Everything else keeps the app's defaults. */
export function profileFromOrg(o: Pick<Org, "legalName" | "country" | "currency" | "gstStateCode">): Profile {
  return { ...DEFAULT_PROFILE, name: o.legalName.trim() || "My business", country: o.country || DEFAULT_PROFILE.country, currency: o.currency || DEFAULT_PROFILE.currency, gstState: o.gstStateCode || "" };
}
