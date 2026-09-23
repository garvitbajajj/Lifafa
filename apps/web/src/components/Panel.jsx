export default function Panel({ title, children, empty, emptyText = 'Nothing yet.' }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {empty ? <p className="empty">{emptyText}</p> : children}
    </section>
  );
}
