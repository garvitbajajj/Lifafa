import { useCallback, useEffect, useState } from 'react';
import { api, rupees } from './api.js';
import Mesh from './components/Mesh.jsx';
import Panel from './components/Panel.jsx';

const POLL_MS = 1500;

export default function App() {
  const [mesh, setMesh] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [journal, setJournal] = useState([]);
  const [claims, setClaims] = useState(null);
  const [invariants, setInvariants] = useState(null);
  const [key, setKey] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const note = useCallback((text) => {
    setLog((entries) => [{ at: new Date().toLocaleTimeString(), text }, ...entries].slice(0, 12));
  }, []);

  const refresh = useCallback(async () => {
    const [meshState, accountRows, journalRows, claimState, invariantState, settlementKey] = await Promise.all([
      api.mesh(),
      api.accounts(),
      api.journal(),
      api.claims(),
      api.invariants(),
      api.settlementKey(),
    ]);
    if (meshState) setMesh(meshState);
    if (accountRows) setAccounts(accountRows);
    if (journalRows) setJournal(journalRows);
    if (claimState) setClaims(claimState);
    if (invariantState) setInvariants(invariantState);
    if (settlementKey) setKey(settlementKey);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Runs one action, then refreshes, so the page always shows what actually happened. */
  const act = async (label, action) => {
    setBusy(true);
    const result = await action();
    if (result === null) note(`${label}: the service refused or is unreachable`);
    else note(label);
    if (result?.handovers !== undefined) note(`  ${result.handovers} envelope(s) handed over`);
    for (const outcome of result?.outcomes ?? []) {
      note(`  ${outcome.nodeId}: ${outcome.outcome}${outcome.replay ? ' (replay)' : ''}${outcome.code && outcome.outcome !== 'SETTLED' ? ` - ${outcome.code}` : ''}`);
    }
    await refresh();
    setBusy(false);
  };

  return (
    <div className="page">
      <header>
        <h1>Lifafa</h1>
        <p>A payment signed with no internet, carried by strangers' phones, settled exactly once.</p>
      </header>

      <section className="controls">
        <button disabled={busy} onClick={() => act('Alice signs ₹250 to the chai stall', () => api.compose({ from: 'alice@lifafa', to: 'chai@lifafa', amountPaise: 25_000 }))}>
          Sign a payment
        </button>
        <button disabled={busy} onClick={() => act('Gossip round', api.gossip)}>Gossip</button>
        <button disabled={busy} onClick={() => act('Bridges deliver', api.flush)}>Deliver</button>
        <span className="spacer" />
        <button disabled={busy} className="secondary" onClick={() => act('Alice signs the same money twice', () => api.doubleSpend({ to: 'chai@lifafa', amountPaise: 25_000 }))}>
          Double spend
        </button>
        <button disabled={busy} className="secondary" onClick={() => act(mesh?.partitioned ? 'Mesh healed' : 'Mesh partitioned', mesh?.partitioned ? api.heal : api.partition)}>
          {mesh?.partitioned ? 'Heal mesh' : 'Partition mesh'}
        </button>
        <button disabled={busy} className="secondary" onClick={() => act('Settlement key rotated', api.rotateKeys)}>Rotate key</button>
        <button disabled={busy} className="secondary" onClick={() => act('Mesh cleared', api.reset)}>Clear mesh</button>
      </section>

      <Mesh state={mesh} />

      <div className="grid">
        <Panel title="Accounts" empty={accounts.length === 0}>
          <table>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.vpa}>
                  <td className="mono">{account.vpa}</td>
                  <td>{account.holder_name}</td>
                  <td className="figure">{rupees(account.balance_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="What just happened" empty={log.length === 0} emptyText="Sign a payment to begin.">
          <ul className="log">
            {log.map((entry, index) => (
              <li key={index}>
                <span className="time">{entry.at}</span> {entry.text}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Ledger" empty={journal.length === 0}>
          <table>
            <tbody>
              {journal.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">#{entry.id}</td>
                  <td>{entry.kind}</td>
                  <td className="mono small">{entry.postings.map((posting) => `${posting.vpa} ${posting.amountPaise > 0 ? '+' : ''}${posting.amountPaise}`).join('  ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Claims on payment intents" empty={!claims}>
          <p className="counts">
            {Object.entries(claims?.counts ?? {}).map(([state, count]) => (
              <span key={state} className={`pill ${state.toLowerCase()}`}>{state} {count}</span>
            ))}
          </p>
          <table>
            <tbody>
              {(claims?.recent ?? []).slice(0, 6).map((claim) => (
                <tr key={claim.idempotency_key}>
                  <td className="mono small">{claim.idempotency_key.slice(0, 28)}…</td>
                  <td><span className={`pill ${claim.state.toLowerCase()}`}>{claim.state}</span></td>
                  <td className="small">{claim.reason_code ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <footer>
        <span className={invariants?.holds ? 'ok' : 'bad'}>
          {invariants?.holds ? 'Ledger balances' : 'LEDGER DRIFT'}
          {invariants ? ` · postings sum ${invariants.postingSum}` : ''}
        </span>
        {key && <span className="mono small">settlement key #{key.keyId}</span>}
      </footer>
    </div>
  );
}
