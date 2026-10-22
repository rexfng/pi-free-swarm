import type { ReactNode } from "react";
import styles from "./Lab.module.css";

interface Column<Row> {
  label: string;
  render: (row: Row) => ReactNode;
  fullWidth?: boolean;
}

export function LabTable<Row>({
  label,
  rows,
  rowKey,
  columns,
}: {
  label: string;
  rows: Row[];
  rowKey: (row: Row) => string | number;
  columns: Column<Row>[];
}) {
  return (
    <>
      <table className={styles.table} aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.label} scope="col" className={column.fullWidth ? styles.proseColumn : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.label}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.records} role="list" aria-label={label}>
        {rows.map((row) => (
          <div className={styles.record} role="listitem" key={rowKey(row)}>
            <dl>
              {columns.map((column) => (
                <div key={column.label} className={column.fullWidth ? styles.fullField : styles.field}>
                  <dt>{column.label}</dt>
                  <dd>{column.render(row)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}
