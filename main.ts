/* SPDX-FileCopyrightText: 2016-present Kriasoft <hello@kriasoft.com> */
/* SPDX-License-Identifier: MIT */

import fs from "fs";
import { Knex } from "knex";
import { camelCase, upperFirst } from "lodash";
import type { Writable } from "stream";

export type Options = {
  /**
   * Filename or output stream where the type definitions needs to be written.
   */
  output: Writable | string;

  /**
   * Name overrides for enums, classes, and fields.
   *
   * @example
   *   overrides: {
   *     "identity_provider.linkedin": "LinkedIn"
   *   }
   */
  overrides?: Record<string, string>;

  prefix?: string;
  suffix?: string;

  /**
   * Schemas that should be included/excluded when generating types.
   *
   * By default if this is null/not specified, "public" will be the only schema added, but if this property
   * is specified, public will be excluded by default and has to be included in the list to be added to the output.
   * If a schema is added by its name, i.e. 'log' all tables from that schema will be added.
   * If a schema name is added with an exclamation mark it will be ignored, i.e. "!log".
   *
   * The table-type will be prefixed by its schema name, the table log.message will become LogMessage.
   *
   * @example
   *   // This will include "public" and "log", but exclude the "auth" schema.
   *   schema: ["public", "log", "!auth"]
   * @default
   *   "public"
   */
  schema?: string[] | string;

  /**
   * A comma separated list or an array of tables that should be excluded when
   * generating types.
   *
   * @example
   *   exclude: ["migration", "migration_lock"]
   */
  exclude?: string[] | string;
};

/**
 * Generates TypeScript definitions (types) from a PostgreSQL database schema.
 */
export async function updateTypes(db: Knex, options: Options): Promise<void> {
  const overrides: Record<string, string> = options.overrides ?? {};
  const output: Writable =
    typeof options.output === "string"
      ? fs.createWriteStream(options.output, { encoding: "utf-8" })
      : options.output;

  [
    "// The TypeScript definitions below are automatically generated.\n",
    "// Do not touch them, or risk, your modifications being lost.\n\n",
  ].forEach((line) => output.write(line));

  const schema = (typeof options.schema === "string"
    ? options.schema.split(",").map((x) => x.trim())
    : options.schema) ?? ["public"];

  // Schemas to include or exclude
  const [includeSchemas, excludeSchemas] = schema.reduce(
    (acc, s) =>
      (acc[+s.startsWith("!")].push(s) && acc) as [string[], string[]],
    [[] as string[], [] as string[]]
  );

  // Tables to exclude
  const exclude =
    (typeof options.exclude === "string"
      ? options.exclude.split(",").map((x) => x.trim())
      : options.exclude) ?? [];

  if (options.prefix) {
    output.write(options.prefix);
    output.write("\n\n");
  }

  try {
    // Fetch the list of custom enum types
    const enums: Enum[] = await db
      .table("pg_type")
      .join("pg_enum", "pg_enum.enumtypid", "pg_type.oid")
      .orderBy("pg_type.typname")
      .orderBy("pg_enum.enumsortorder")
      .select<Enum[]>("pg_type.typname as key", "pg_enum.enumlabel as value");

    // Construct TypeScript type union from enum
    enums.forEach((x, i) => {
      // The first line of enum declaration
      const enumName = overrides[x.key] ?? upperFirst(camelCase(x.key));
      if (!(enums[i - 1] && enums[i - 1].key === x.key)) {
        output.write(`export const ${enumName} = {\n`);
      }

      // Enum body
      output.write(`  "${x.value}": "${x.value}",\n`);

      // The closing line
      if (!(enums[i + 1] && enums[i + 1].key === x.key)) {
        output.write("};\n");
        output.write(`export type ${enumName} = keyof typeof ${enumName};\n\n`);
      }
    });

    const enumsMap = new Map(
      enums.map((x) => [
        x.key,
        overrides[x.key] ?? upperFirst(camelCase(x.key)),
      ])
    );

    // Fetch the list of tables/columns
    const columns = await db
      .withSchema("information_schema")
      .table("columns")
      .whereIn("table_schema", includeSchemas)
      .whereNotIn("table_schema", excludeSchemas)
      .whereNotIn("table_name", exclude)
      .orderBy("table_schema")
      .orderBy("table_name")
      .orderBy("ordinal_position")
      .select<Column[]>(
        "table_schema as schema",
        "table_name as table",
        "column_name as column",
        db.raw("(is_nullable = 'YES') as nullable"),
        "column_default as default",
        "data_type as type",
        "udt_name as udt"
      );

    let keys: Key[] = [];

    for (const schema of includeSchemas) {
      // as we can't join internal tables (for some reasons) we need to fetch the keys separately
      const keyConstraints = await db
        .withSchema("information_schema")
        .table("table_constraints")
        .where("table_schema", schema)
        .whereIn("constraint_type", ["FOREIGN KEY", "UNIQUE", "PRIMARY KEY"])
        .select<{ constraint_name: string; constraint_type: string }[]>([
          "constraint_name",
          "constraint_type",
        ]);

      const keyUsage = await db
        .withSchema("information_schema")
        .table("key_column_usage")
        .where("table_schema", schema)
        .whereIn(
          "constraint_name",
          keyConstraints.map((x) => x.constraint_name)
        )
        .select<Partial<Key>[]>(
          "table_schema as schema",
          "table_name as table",
          "column_name as column",
          "constraint_name"
        );

      const columnUsage = await db
        .withSchema("information_schema")
        .table("constraint_column_usage")
        .whereIn(
          "constraint_name",
          keyConstraints.map((x) => x.constraint_name)
        )
        .select<Partial<Key>[]>(
          "table_schema as schema",
          "table_name as table",
          "column_name as column",
          "constraint_name"
        );

      keys = [
        ...keys,
        ...keyUsage.map((key) => {
          // look up the constraint type
          const constraintType = keyConstraints.find(
            (constraint) => constraint.constraint_name === key.constraint_name
          )?.constraint_type;
          const refSchema = columnUsage.find(
            (column) => column.constraint_name === key.constraint_name
          );
          return {
            ...key,
            constraint_type: constraintType,
            refSchema,
          } as Key;
        }),
      ];
    }

    const columnsWithKeyInfo = columns.map((column) => {
      return {
        ...column,
        is_foreign_key: keys.some(
          (key) =>
            key.table === column.table &&
            key.column === column.column &&
            key.constraint_type === "FOREIGN KEY"
        ),
        is_unique: keys.some(
          (key) =>
            key.table === column.table &&
            key.column === column.column &&
            key.constraint_type === "UNIQUE"
        ),
        is_primary_key: keys.some(
          (key) =>
            key.table === column.table &&
            key.column === column.column &&
            key.constraint_type === "PRIMARY KEY"
        ),
        ref_schema: keys.find(
          (key) =>
            key.table === column.table &&
            key.column === column.column &&
            key.constraint_type === "FOREIGN KEY"
        )?.refSchema,
      };
    });

    // The list of database tables as enum
    output.write("export enum Table {\n");
    const tableSet = new Set(
      columnsWithKeyInfo.map((x) => {
        const schema = x.schema !== "public" ? `${x.schema}.` : "";
        return `${schema}${x.table}`;
      })
    );
    Array.from(tableSet).forEach((value) => {
      const key = overrides[value] ?? upperFirst(camelCase(value));
      output.write(`  ${key} = "${value}",\n`);
    });
    output.write("}\n\n");
    // The list of tables as type
    output.write("export type Tables = {\n");
    Array.from(tableSet).forEach((key) => {
      const value = overrides[key] ?? upperFirst(camelCase(key));
      output.write(`  "${key}": ${value},\n`);
    });
    output.write("};\n\n");

    // Construct TypeScript db record types
    columnsWithKeyInfo.forEach((x, i) => {
      const schemaName =
        x.schema !== "public" ? upperFirst(camelCase(x.schema)) : "";

      const tableName = overrides[x.table] ?? upperFirst(camelCase(x.table));
      if (
        !(
          columnsWithKeyInfo[i - 1] &&
          columnsWithKeyInfo[i - 1].table === x.table
        )
      ) {
        output.write(`export type ${schemaName}${tableName} = {\n`);
      }

      let type =
        x.type === "ARRAY"
          ? `${getType(x.udt.substring(1), enumsMap, x.default)}[]`
          : getType(x.udt, enumsMap, x.default);

      // branding the id columns (unique and foreign keys)
      if (x.column === "id" && (x.is_unique || x.is_primary_key)) {
        const brandName = `${schemaName}${tableName}`;
        type += ` & { _brand: "${brandName}" }`;
      } else if (x.is_foreign_key && x.column.endsWith("id")) {
        const refSchemaName =
          x.ref_schema?.schema !== "public"
            ? upperFirst(camelCase(x.ref_schema?.schema))
            : "";
        const refTableName = upperFirst(camelCase(x.ref_schema?.table));
        const brandName = `${refTableName}Id`;
        type += ` & { __flavor?: "${brandName}" }`;
      }

      if (x.nullable) {
        type += " | null";
      }

      output.write(`  ${sanitize(x.column)}: ${type};\n`);

      if (
        !(
          columnsWithKeyInfo[i + 1] &&
          columnsWithKeyInfo[i + 1].table === x.table
        )
      ) {
        output.write("};\n\n");
      }
    });

    if (options.suffix) {
      output.write(options.suffix);
      output.write("\n");
    }
  } finally {
    output.end();
    db.destroy();
  }
}

type Enum = {
  key: string;
  value: string;
};

type Column = {
  table: string;
  column: string;
  schema: string;
  nullable: boolean;
  unique: boolean;
  default: string | null;
  type: string;
  udt: string;
};

type Key = {
  schema: string;
  table: string;
  column: string;
  constraint_name: string;
  constraint_type: string;
  refSchema?: {
    schema: string;
    table: string;
    column: string;
  };
};

export function getType(
  udt: string,
  customTypes: Map<string, string>,
  defaultValue: string | null
): string {
  switch (udt) {
    case "bool":
      return "boolean";
    case "text":
    case "citext":
    case "money":
    case "numeric":
    case "int8":
    case "char":
    case "character":
    case "bpchar":
    case "varchar":
    case "time":
    case "tsquery":
    case "tsvector":
    case "uuid":
    case "xml":
    case "cidr":
    case "inet":
    case "macaddr":
      return "string";
    case "smallint":
    case "integer":
    case "int":
    case "int2":
    case "int4":
    case "real":
    case "float":
    case "float4":
    case "float8":
      return "number";
    case "date":
    case "timestamp":
    case "timestamptz":
      return "Date";
    case "json":
    case "jsonb":
      if (defaultValue) {
        if (defaultValue.startsWith("'{")) {
          return "Record<string, unknown>";
        }
        if (defaultValue.startsWith("'[")) {
          return "unknown[]";
        }
      }
      return "unknown";
    case "bytea":
      return "Buffer";
    case "interval":
      return "PostgresInterval";
    default:
      return customTypes.get(udt) ?? "unknown";
  }
}

/**
 * Wraps the target property identifier into quotes in case it contains any
 * invalid characters.
 *
 * @see https://developer.mozilla.org/docs/Glossary/Identifier
 */
function sanitize(name: string): string {
  return /^[a-zA-Z$_][a-zA-Z$_0-9]*$/.test(name) ? name : JSON.stringify(name);
}
