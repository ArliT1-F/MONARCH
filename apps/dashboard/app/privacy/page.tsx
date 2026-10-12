import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — Monarch",
  description:
    "How Monarch collects, uses, stores, and protects information when you use the Monarch dashboard and Discord bot.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" updatedAt="October 12, 2026">
      <p>
        Monarch (&quot;Monarch&quot;, &quot;we&quot;, &quot;us&quot;) is a visual design studio for
        Discord servers: you connect your Discord account, design server structure, channels,
        roles, embeds and messages in the dashboard, preview the exact diff, and apply it to your
        server only when you approve it. This Privacy Policy explains what information we
        collect, why we collect it, and the choices you have. It applies to the Monarch website,
        dashboard, and the Monarch Discord bot (together, the &quot;Service&quot;).
      </p>

      <LegalSection title="1. Information we collect">
        <p>
          <strong className="text-ink-100">Information from Discord (OAuth2).</strong> When you
          sign in with Discord, we request the <code className="text-ink-100">identify</code> and{" "}
          <code className="text-ink-100">guilds</code> scopes. That gives us your Discord user ID,
          username, and avatar, plus the list of servers you belong to and your permissions in
          them — so we can show your servers and check that you can manage the ones you design.
        </p>
        <p>
          <strong className="text-ink-100">Server data you work with.</strong> To build diffs and
          apply changes, we process the structure of the servers you select: categories, channels,
          roles, permissions you edit, designated channels, backups/snapshots, drafts, templates,
          embed and message designs, and the audit history of changes you apply.
        </p>
        <p>
          <strong className="text-ink-100">Credentials &amp; sessions.</strong> We store an opaque
          session identifier in an HTTP-only cookie. Discord OAuth tokens are kept server-side and
          encrypted at rest (AES-GCM); they never reach your browser.
        </p>
        <p>
          <strong className="text-ink-100">Confessions.</strong> Confessions are anonymous by
          design. We store only a per-user cooldown timestamp (so the 6-hour limit works across
          servers) — never the confession text, your identity tied to a confession, or its content
          in our systems. Confession text is posted into the channel you chose inside Discord, and
          any staff log lives in your server&apos;s private log channel.
        </p>
        <p>
          <strong className="text-ink-100">Technical logs.</strong> Like most services, our
          servers record standard request logs (IP address, timestamps, requested paths, errors)
          for security and debugging.
        </p>
        <p>
          <strong className="text-ink-100">Demo mode.</strong> If Monarch runs in demo mode, no
          Discord account or real server is involved; all data is mock data.
        </p>
      </LegalSection>

      <LegalSection title="2. How we use information">
        <p>We use the information above to:</p>
        <ul className="list-disc space-y-1.5 pl-5 marker:text-royal-400">
          <li>Provide the Service — sign you in, list your servers, store drafts and designs;</li>
          <li>
            Compute diffs, validation, snapshots, and apply changes to Discord only after you
            explicitly approve them;
          </li>
          <li>Operate backups, version history, templates, and the audit trail;</li>
          <li>Keep the Service secure, prevent abuse, and diagnose problems;</li>
          <li>Comply with legal obligations.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. What we don’t do">
        <ul className="list-disc space-y-1.5 pl-5 marker:text-royal-400">
          <li>We never sell or rent your personal information.</li>
          <li>We don&apos;t run ads or track you across other websites.</li>
          <li>
            We don&apos;t read or store the content of your Discord messages — Monarch acts on the
            structures and designs you create in the dashboard and on commands/modals you invoke.
          </li>
          <li>Nothing changes in your server until you review and approve the diff.</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. How information is shared">
        <p>
          We share information only with processors that run the Service — our hosting/database
          infrastructure and Discord itself. When you approve a diff, the resulting API calls are
          sent to Discord so the change can happen; Discord&apos;s own processing is governed by{" "}
          <a
            href="https://discord.com/privacy"
            className="text-royal-400 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Discord&apos;s Privacy Policy
          </a>
          . We also disclose information if required by law, or to protect the rights, safety, and
          property of Monarch, our users, or the public. We never share your OAuth tokens in
          plaintext.
        </p>
      </LegalSection>

      <LegalSection title="5. Data storage &amp; security">
        <p>
          Data is stored in a managed database (PostgreSQL) on our hosting infrastructure. OAuth
          tokens are encrypted at rest with AES-GCM; session cookies are HTTP-only, signed, and
          Secure when served over HTTPS. Access to production data is limited to what&apos;s needed
          to operate and debug the Service. No method of transmission or storage is 100% secure,
          but we aim to use practices proportionate to the data we hold.
        </p>
      </LegalSection>

      <LegalSection title="6. Retention">
        <p>
          We keep account and design data for as long as your account exists or as long as needed
          to provide the Service. Sessions expire after 14 days. You can ask us to delete your
          data at any time (see Contact below), and disconnecting Monarch from your Discord account
          in Discord&apos;s settings stops any future sign-in. Backup snapshots and audit entries
          for a server are removed along with that server&apos;s data when a deletion is requested.
        </p>
      </LegalSection>

      <LegalSection title="7. Your rights &amp; choices">
        <ul className="list-disc space-y-1.5 pl-5 marker:text-royal-400">
          <li>
            <strong className="text-ink-100">Access/correction:</strong> most profile information
            mirrors Discord and updates when you re-authenticate;
          </li>
          <li>
            <strong className="text-ink-100">Deletion:</strong> contact us to delete your account
            and associated data;
          </li>
          <li>
            <strong className="text-ink-100">Disconnect:</strong> revoke Monarch&apos;s access any
            time via Discord → User Settings → Authorized Apps;
          </li>
          <li>
            <strong className="text-ink-100">Server owners:</strong> removing the bot from your
            server stops all further processing for that server.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="8. Children&apos;s privacy">
        <p>
          The Service is not directed at children under 13 (or the minimum age required by Discord
          in your country, generally 13+). We don&apos;t knowingly collect personal information
          from children. If you believe a child has provided us data, contact us and we will delete
          it.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. The &quot;Last updated&quot; date at
          the top shows when it last changed. Material changes will be announced in the dashboard
          or our repository. Continued use of the Service after changes take effect constitutes
          acceptance of the revised policy.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          For questions, requests, or concerns about privacy, open an issue on our{" "}
          <a
            href="https://github.com/ArliT1-F/MONARCH"
            className="text-royal-400 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub repository
          </a>{" "}
          or reach out through the channels listed there. We&apos;ll respond as soon as we can.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
