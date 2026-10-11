// better-sqlite3-multiple-ciphers tiene la misma API que better-sqlite3, pero sus tipos no se
// resuelven con "exports"; se reutilizan los de @types/better-sqlite3.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
