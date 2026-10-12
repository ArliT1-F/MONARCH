import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — Monarch",
  description:
    "The terms that apply when you use the Monarch dashboard and Discord bot to design Discord servers.",
};

export default function TermsOfServicePage() {
  return (
    <LegalPage title="Terms of Service" updatedAt="October 12, 2026">
      <p>
        These Terms of Service (&quot;Terms&quot;) govern your use of Monarch — the website,
        dashboard, and Discord bot (together, the &quot;Service&quot;). By signing in, using the
        Service, or inviting the bot to a server, you agree to these Terms. If you do not agree,
        do not use the Service.
      </p>

      <LegalSection title="1. The Service">
        <p>
          Monarch is a visual design and customization studio for Discord servers. It lets you
          design server structure, channels, categories, roles, embeds and messages, preview the
          exact diff, and apply approved changes to Discord. Monarch is not a moderation bot and
          does not become one. The Service may include drafts, backups and snapshots, templates,
          a design analyzer, and related tooling.
        </p>
      </LegalSection>

      <LegalSection title="2. Eligibility">
        <p>
          You must meet the minimum age required to use Discord (generally 13 years or older, or
          higher in your country) and be able to enter into a binding agreement. You must also
          comply with{" "}
          <a
            href="https://discord.com/terms"
            className="text-royal-400 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Discord&apos;s Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="https://discord.com/guidelines"
            className="text-royal-400 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Community Guidelines
          </a>{" "}
          whenever you use Monarch with Discord.
        </p>
      </LegalSection>

      <LegalSection title="3. Accounts &amp; sign-in">
        <p>
          Monarch authenticates through Discord OAuth2. You are responsible for the activity on
          your Discord account and for keeping it secure. If you use Monarch on behalf of a server
          or organization, you represent that you have authority to bind it to these Terms. Demo
          mode, when enabled, uses mock data and does not require a Discord account.
        </p>
      </LegalSection>

      <LegalSection title="4. Your content">
        <p>
          You retain all rights to the designs, drafts, templates, backups, and other content you
          create in the Service (&quot;Your Content&quot;). So that Monarch can operate, you grant
          us a limited, non-exclusive, worldwide license to store, process, and transmit Your
          Content solely to provide the Service — for example, to render previews, compute diffs,
          and send changes to Discord when you approve them. You are responsible for Your Content
          and for having the rights to apply it to any server you manage.
        </p>
      </LegalSection>

      <LegalSection title="5. Changes to Discord — your responsibility">
        <p>
          Monarch follows a strict draft → preview → diff → confirm → apply flow: nothing touches
          your server until you approve the diff. Once you approve, the resulting changes are made
          through Discord&apos;s API under your permissions. You are responsible for reviewing
          diffs before applying them and for any changes made to servers where you hold
          administrative rights.
        </p>
      </LegalSection>

      <LegalSection title="6. Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1.5 pl-5 marker:text-royal-400">
          <li>Use the Service for any unlawful, misleading, or fraudulent purpose;</li>
          <li>
            Use Monarch to violate Discord&apos;s Terms, Community Guidelines, or the rights of
            others;
          </li>
          <li>
            Infringe intellectual property, privacy, or other rights when saving or publishing
            templates, embeds, or messages;
          </li>
          <li>Probe, breach, or circumvent security or rate limits, or interfere with the Service;</li>
          <li>Reverse engineer or resell the Service except where applicable law expressly permits;</li>
          <li>Use automated access to the Service in a way that imposes unreasonable load.</li>
        </ul>
      </LegalSection>

      <LegalSection title="7. Third-party services">
        <p>
          The Service depends on Discord. Your use of Discord is governed by Discord&apos;s own
          terms and policies, and we are not responsible for Discord&apos;s availability, actions,
          or decisions — including the removal of the Monarch bot from a server or revocation of
          authorization. We may also rely on other infrastructure providers to host the Service.
        </p>
      </LegalSection>

      <LegalSection title="8. No warranties">
        <p>
          The Service is provided &quot;as is&quot; and &quot;as available&quot; without warranties
          of any kind, whether express or implied, including merchantability, fitness for a
          particular purpose, and non-infringement. We do not warrant that the Service will be
          uninterrupted, error-free, or safe for every server configuration, or that diffs,
          validation, or backups will always be complete or accurate. Always review previews before
          applying changes.
        </p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Monarch and its contributors shall not be liable
          for any indirect, incidental, special, consequential, or punitive damages, or any loss of
          data, server content, profits, or goodwill, arising from your use of the Service —
          including changes applied to Discord after your approval. Our total liability for any
          claim arising out of these Terms shall not exceed the greater of the amount you paid us
          for the Service in the 12 months before the claim or USD $50. Some jurisdictions do not
          allow certain limitations, so these may not apply to you.
        </p>
      </LegalSection>

      <LegalSection title="10. Termination">
        <p>
          You may stop using the Service at any time, revoke our Discord authorization, or ask us
          to delete your data. We may suspend or terminate access if you materially breach these
          Terms, if required by law, or to protect the Service and its users. Sections that by
          their nature should survive termination (including licenses you granted, disclaimers,
          and limitations of liability) survive it.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes to the Service or these Terms">
        <p>
          We may modify or discontinue features of the Service at any time. We may update these
          Terms; the &quot;Last updated&quot; date at the top shows the latest revision. Material
          changes will be announced in the dashboard or our repository. Continued use after the
          changes take effect means you accept the updated Terms.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact">
        <p>
          Questions about these Terms? Open an issue on our{" "}
          <a
            href="https://github.com/ArliT1-F/MONARCH"
            className="text-royal-400 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub repository
          </a>{" "}
          or reach out through the channels listed there.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
