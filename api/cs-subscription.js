// /pages/cs-subscriptions.js
import { useState } from "react";

export default function CsSubscriptionsPage() {
  const [customerId, setCustomerId] = useState("");
  const [email, setEmail] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingCancel, setLoadingCancel] = useState(false);
  const [subsResult, setSubsResult] = useState(null);
  const [cancelResult, setCancelResult] = useState(null);
  const [error, setError] = useState("");

  async function loadSubscriptions() {
    setError("");
    setCancelResult(null);

    if (!customerId || !email) {
      setError("Vul zowel klant ID als e-mailadres in.");
      return;
    }

    setLoadingList(true);
    try {
      const resp = await fetch("/api/cs-list-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, email }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(data.error || "Kon abonnementen niet ophalen.");
        setSubsResult(null);
      } else {
        setSubsResult(data);
      }
    } catch (err) {
      console.error(err);
      setError("Er ging iets mis bij het ophalen van de abonnementen.");
    } finally {
      setLoadingList(false);
    }
  }

  async function handleViewSubscriptions(e) {
    e.preventDefault();
    await loadSubscriptions();
  }

  async function handleCancelAll(e) {
    e.preventDefault();
    setError("");
    setCancelResult(null);

    if (!customerId || !email) {
      setError("Vul zowel klant ID als e-mailadres in.");
      return;
    }

    if (
      !window.confirm(
        "Weet je zeker dat je alle actieve abonnementen voor deze klant wilt stopzetten?"
      )
    ) {
      return;
    }

    setLoadingCancel(true);
    try {
      const resp = await fetch("/api/cs-cancel-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, email }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(data.error || "Er ging iets mis bij het annuleren.");
      } else {
        setCancelResult(data);
        // Na succesvolle cancel: lijst opnieuw ophalen
        await loadSubscriptions();
      }
    } catch (err) {
      console.error(err);
      setError("Er ging iets mis bij het annuleren.");
    } finally {
      setLoadingCancel(false);
    }
  }

  const subscriptions = subsResult?.subscriptions || [];

  return (
    <main
      style={{
        maxWidth: "1000px",
        margin: "0 auto",
        padding: "1.5rem",
        borderRadius: "0",
        boxShadow: "none",
        fontFamily:
          "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
        backgroundColor: "#ffffff",
      }}
    >
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>
        Fort Negen – CS Abonnemententool
      </h1>
      <p
        style={{
          fontSize: "0.9rem",
          marginBottom: "1.25rem",
          color: "#4b5563",
        }}
      >
        Zoek op Mollie <strong>klant ID</strong> (bijv. <code>cst_xxx</code>) en{" "}
        <strong>e-mailadres</strong>. Je kunt eerst de abonnementen bekijken en
        daarna alle actieve abonnementen stopzetten.
      </p>

      <form
        onSubmit={handleViewSubscriptions}
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1.5fr auto auto",
          gap: "0.75rem",
          alignItems: "end",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <label
            style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" }}
          >
            Klant ID (Mollie)
          </label>
          <input
            type="text"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="cst_..."
            style={{
              width: "100%",
              padding: "0.5rem 0.6rem",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "0.9rem",
            }}
          />
        </div>

        <div>
          <label
            style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" }}
          >
            E-mailadres
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="klant@example.com"
            style={{
              width: "100%",
              padding: "0.5rem 0.6rem",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "0.9rem",
            }}
          />
        </div>

        <button
          type="submit"
          disabled={loadingList}
          style={{
            padding: "0.55rem 0.9rem",
            borderRadius: "999px",
            border: "none",
            fontSize: "0.9rem",
            cursor: loadingList ? "default" : "pointer",
            whiteSpace: "nowrap",
            backgroundColor: "#e5e7eb",
          }}
        >
          {loadingList ? "Laden..." : "Bekijk abonnementen"}
        </button>

        <button
          type="button"
          onClick={handleCancelAll}
          disabled={loadingCancel}
          style={{
            padding: "0.55rem 0.9rem",
            borderRadius: "999px",
            border: "none",
            fontSize: "0.9rem",
            cursor: loadingCancel ? "default" : "pointer",
            whiteSpace: "nowrap",
            backgroundColor: "#dc2626",
            color: "#fff",
          }}
        >
          {loadingCancel ? "Annuleren..." : "Stop alle actieve"}
        </button>
      </form>

      {error && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            backgroundColor: "#fee2e2",
            borderRadius: "8px",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {cancelResult && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            backgroundColor: "#ecfdf3",
            borderRadius: "8px",
            fontSize: "0.9rem",
          }}
        >
          <p style={{ margin: 0 }}>
            {cancelResult.message || "Annulering voltooid."}
          </p>
          <p style={{ margin: "0.25rem 0 0" }}>
            Geannuleerde abonnementen:{" "}
            <strong>{cancelResult.canceledCount ?? 0}</strong>
            {cancelResult.cancelAtDate && (
              <>
                {" "}
                – toegang tot en met:{" "}
                <strong>{cancelResult.cancelAtDate}</strong>
              </>
            )}
          </p>
        </div>
      )}

      <section>
        <h2 style={{ fontSize: "1.05rem", marginBottom: "0.5rem" }}>
          Abonnementen
        </h2>
        {!subsResult && (
          <p style={{ fontSize: "0.9rem", color: "#6b7280" }}>
            Nog geen resultaten. Vul klantgegevens in en klik op{" "}
            <strong>Bekijk abonnementen</strong>.
          </p>
        )}

        {subsResult && subscriptions.length === 0 && (
          <p style={{ fontSize: "0.9rem", color: "#6b7280" }}>
            Geen abonnementen gevonden voor deze klant.
          </p>
        )}

        {subscriptions.length > 0 && (
          <div style={{ overflowX: "auto", maxHeight: "55vh", overflowY: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr style={{ backgroundColor: "#f3f4f6" }}>
                  <th style={thStyle}>ID</th>
                  <th style={thStyle}>Beschrijving</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Bedrag</th>
                  <th style={thStyle}>Interval</th>
                  <th style={thStyle}>Startdatum</th>
                  <th style={thStyle}>Volgende betaling</th>
                  <th style={thStyle}>Aangemaakt</th>
                  <th style={thStyle}>Geannuleerd</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((sub) => (
                  <tr key={sub.id}>
                    <td style={tdStyle}>
                      <code>{sub.id}</code>
                    </td>
                    <td style={tdStyle}>{sub.description}</td>
                    <td style={{ ...tdStyle, textTransform: "capitalize" }}>
                      {sub.status}
                    </td>
                    <td style={tdStyle}>
                      {sub.amount?.value} {sub.amount?.currency}
                    </td>
                    <td style={tdStyle}>{sub.interval || "-"}</td>
                    <td style={tdStyle}>{sub.startDate || "-"}</td>
                    <td style={tdStyle}>{sub.nextPaymentDate || "-"}</td>
                    <td style={tdStyle}>
                      {sub.createdAt ? sub.createdAt.slice(0, 10) : "-"}
                    </td>
                    <td style={tdStyle}>
                      {sub.canceledAt ? sub.canceledAt.slice(0, 10) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "0.5rem 0.5rem",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "top",
};
