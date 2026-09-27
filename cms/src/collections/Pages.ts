import type { Access, CollectionConfig } from 'payload'

import { isAdminOrEditor, userIsStaff } from '../access'
import {
  allOf,
  checkReviewed,
  checkSlug,
  fillSlugAndSortOrder,
  guardSlug,
  integerIn,
  livePageWhere,
  RESERVED_PAGE_SLUGS,
  requiredToPublish,
  safeHtml,
  SLUG_RE,
} from '../endpoints/catalog/rules'
import { deployHookAfterChange, deployHookAfterDelete } from '../hooks/deployHook'
import { draftSafeRestore } from '../lib/draftSafeRestore'
import { duplicateAsDraft, duplicateSlug, emptyOnDuplicate } from '../lib/duplicateDoc'
import { keepPublishStateOnPlainUpdate } from '../lib/draftSafeUpdate'

/**
 * Policy pages (shipping, refunds, grievances): `pages[]` of the catalog snapshot
 * (SCRATCH/contracts/snapshot-schema.md §5).
 *
 * A page is on the storefront only when BOTH switches are on:
 * - Payload's Publish / draft (_status), and
 * - `published` (the "Show on the storefront" box), which the owner ticks after reviewing the text.
 * Everything else — the policy drafts the seed creates from policy-drafts.server.json, a page published
 * with the box unticked — is staff-only: it is not in the snapshot and customers and guests cannot read
 * it through REST or GraphQL (livePageWhere). A page with the box ticked may not keep the Draft line or a
 * "[to be added]" placeholder (checkReviewed), exactly as the storefront's snapshot validator requires.
 * `sortOrder` only orders the snapshot's pages[] (footer order); it is not part of the snapshot.
 */

/** Staff read every page; customers and guests only the pages the storefront shows. */
const livePageOrStaff: Access = ({ req }) => (userIsStaff(req.user) ? true : livePageWhere())

export const Pages: CollectionConfig = {
  slug: 'pages',
  labels: { singular: 'Page', plural: 'Pages' },
  admin: {
    useAsTitle: 'title',
    group: 'Content',
    defaultColumns: ['title', 'slug', 'published', '_status', 'updatedAt'],
    listSearchableFields: ['title', 'slug'],
    description:
      'Policy pages. A page goes live on the storefront only when "Show on the storefront" is ticked AND it is published. Until then only staff can see it.',
  },
  defaultSort: 'sortOrder',
  versions: { drafts: true, maxPerDoc: 20 },
  access: {
    read: livePageOrStaff,
    // Without this Payload lets ANY logged-in user (customers too) read draft versions.
    readVersions: isAdminOrEditor,
    create: isAdminOrEditor,
    update: isAdminOrEditor,
    delete: isAdminOrEditor,
  },
  hooks: {
    // A save without draft / _status never unpublishes it (src/lib/draftSafeUpdate.ts).
    // Restoring a draft version keeps the live document published (src/lib/draftSafeRestore.ts).
    // Admin Duplicate: a draft copy with a free <slug>-copy slug and the next sortOrder (src/lib/duplicateDoc.ts).
    beforeOperation: [keepPublishStateOnPlainUpdate('page'), draftSafeRestore.beforeOperation, duplicateAsDraft],
    beforeValidate: [fillSlugAndSortOrder('pages', 'title')],
    beforeChange: [
      draftSafeRestore.beforeChange,
      // A storefront path (terms, privacy, shop, …) would never be routed: refused at create.
      guardSlug('pages', SLUG_RE, 'Use lower-case letters, numbers and single hyphens, e.g. shipping.', RESERVED_PAGE_SLUGS),
    ],
    afterChange: [draftSafeRestore.afterChange, deployHookAfterChange],
    afterDelete: [deployHookAfterDelete],
  },
  fields: [
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: requiredToPublish(checkSlug),
      hooks: { beforeDuplicate: [duplicateSlug('pages')] },
      admin: {
        position: 'sidebar',
        description:
          'URL: /<slug>, e.g. shipping. Left empty, it is made from the title. Cannot change later. Not a path the shop already uses (terms, privacy, shop, …).',
      },
    },
    {
      name: 'published',
      type: 'checkbox',
      defaultValue: false,
      label: 'Show on the storefront',
      admin: {
        position: 'sidebar',
        description:
          'Adds the route and footer link once published. Tick it only after reviewing the text: the "Draft — to be reviewed" line and every "[to be added]" must be gone first.',
      },
    },
    {
      name: 'sortOrder',
      type: 'number',
      min: 0,
      index: true,
      validate: requiredToPublish(integerIn(0)),
      hooks: { beforeDuplicate: [emptyOnDuplicate] },
      admin: { position: 'sidebar', step: 10, description: 'Footer order (smaller first). Left empty: after the last one.' },
    },
    { name: 'title', type: 'text', required: true, validate: requiredToPublish(checkReviewed) },
    {
      name: 'bodyHtml',
      label: 'Body (HTML)',
      type: 'code',
      validate: requiredToPublish(allOf(safeHtml, checkReviewed)),
      admin: {
        language: 'html',
        description: 'HTML, rendered as written: <h2>, <p>, <ul>, <li>, <strong>, <a>. No scripts, styles or forms.',
      },
    },
  ],
  timestamps: true,
}
