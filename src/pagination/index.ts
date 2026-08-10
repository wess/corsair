import { db } from "../db/index.ts"

export type PageQuery = {
  page: number
  perPage: number
  search: string
  sort: string | null
  direction: "asc" | "desc"
}

export type Page<T> = {
  object: "list"
  data: T[]
  page: number
  per_page: number
  total: number
  pages: number
}

const PER_PAGE_CHOICES = [10, 25, 50, 100]

export const parsePageQuery = (query: Record<string, string | undefined>): PageQuery => {
  const perPage = Number(query.per_page ?? "10")
  return {
    page: Math.max(1, Number(query.page ?? "1") || 1),
    perPage: PER_PAGE_CHOICES.includes(perPage) ? perPage : 10,
    search: (query.search ?? "").trim(),
    sort: query.sort?.trim() || null,
    direction: query.direction === "desc" ? "desc" : "asc",
  }
}

export type PaginateInput = {
  /** FROM and JOIN clauses, without the keyword. */
  source: string
  /** Columns to select. */
  columns: string
  /** WHERE predicates that always apply, with $1..$n bound from `values`. */
  where: string
  values: unknown[]
  /** Columns `search` may match against, ORed together. */
  searchColumns?: string[]
  /** Column names a caller is allowed to sort by, mapped to SQL. */
  sortable?: Record<string, string>
  defaultSort: string
  query: PageQuery
}

/**
 * Offset pagination.
 *
 * The panel's tables are numbered ("10 per page", page 1 · 2 · 3), which needs
 * a total, and a total needs a count — so there is no point paying the
 * complexity of a cursor here. Every table this serves is scoped to one
 * account, so the offset never walks far.
 *
 * Sort columns are looked up in a whitelist rather than interpolated. The
 * values are still bound; only the column *name* is chosen from a fixed map,
 * which is the only safe way to make ORDER BY dynamic.
 */
export const paginate = async <T>(input: PaginateInput): Promise<Page<T>> => {
  const values = [...input.values]
  let where = input.where

  if (input.query.search && input.searchColumns?.length) {
    values.push(`%${input.query.search}%`)
    const placeholder = `$${values.length}`
    const clauses = input.searchColumns.map((c) => `${c} ILIKE ${placeholder}`)
    where = `${where} AND (${clauses.join(" OR ")})`
  }

  const sortColumn = (input.query.sort && input.sortable?.[input.query.sort]) || input.defaultSort
  const direction = input.query.direction === "desc" ? "DESC" : "ASC"

  const totalRow = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM ${input.source} WHERE ${where}`,
    values,
  })
  const total = Number(totalRow?.count ?? 0)

  const offset = (input.query.page - 1) * input.query.perPage
  const rows = await db().all<T>({
    text: `SELECT ${input.columns} FROM ${input.source} WHERE ${where}
           ORDER BY ${sortColumn} ${direction}
           LIMIT ${input.query.perPage} OFFSET ${offset}`,
    values,
  })

  return {
    object: "list",
    data: rows,
    page: input.query.page,
    per_page: input.query.perPage,
    total,
    pages: Math.max(1, Math.ceil(total / input.query.perPage)),
  }
}
