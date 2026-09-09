/** Vite loads the exact operator-run SQL for real-D1 fixture verification. */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
