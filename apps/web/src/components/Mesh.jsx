/**
 * The mesh, left to right: the payer's phone, two strangers, then the bridges.
 *
 * Each phone shows the envelopes it is carrying - a fingerprint and a hop count, which is all a
 * carrier can see of a payment.
 */
export default function Mesh({ state }) {
  if (!state) {
    return (
      <section className="mesh empty-mesh">
        <p className="empty">Waiting for the service. Is it running in demo mode?</p>
      </section>
    );
  }

  return (
    <section className="mesh">
      {state.nodes.map((node, index) => (
        <div key={node.id} className="hop">
          <div className={`node ${node.isBridge ? 'bridge' : ''} ${node.partitioned ? 'cut' : ''}`}>
            <h3>{node.id}</h3>
            <p className="role">{node.isBridge ? 'has internet' : 'no internet'}</p>
            {node.holding.length === 0 ? (
              <p className="empty">empty</p>
            ) : (
              <ul>
                {node.holding.map((envelope) => (
                  <li key={envelope.fingerprint} className="envelope" title={`${envelope.bytes} bytes`}>
                    <span className="mono">{envelope.fingerprint}</span>
                    <span className="hops">{envelope.hops} hop{envelope.hops === 1 ? '' : 's'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {index < state.nodes.length - 1 && (
            <span className={`link ${state.partitioned && index === 0 ? 'broken' : ''}`}>
              {state.partitioned && index === 0 ? '✕' : '→'}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
