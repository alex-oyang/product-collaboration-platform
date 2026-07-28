export type JobType = '产品' | '美术' | '研发' | 'UE' | '项目' | '其他'
export type SystemRole = 'admin' | 'user'
export type ProductState = 'draft' | 'online' | 'offline' | 'trash'
export type ReviewState = 'pending' | 'reviewing' | 'completed'
export type AnnotationStatus = 'open' | 'resolved' | 'needs-relocation'

export interface User {
  id: string
  username: string
  name: string
  role: SystemRole
  job: JobType
  avatar: string
  enabled: boolean
  mustChangePassword?: boolean
}

export interface ProductMember {
  userId: string
  source: 'code' | 'manual' | 'transfer'
  grantedAt: string
  codeVersion: number
}

export interface VersionRecord {
  id: string
  version: string
  note: string
  uploaderId: string
  createdAt: string
  fileName: string
  fileSize: number
  entryUrl: string
  isCurrent: boolean
  gitTag?: string
  gitCommit?: string
}

export interface UploadRecord {
  id: string
  productId: string
  productName: string
  fileName: string
  uploaderId: string
  createdAt: string
  status: 'success' | 'failed'
  version?: string
  error?: string
}

export interface ImageAttachment {
  id: string
  name: string
  type: string
  size: number
  dataUrl: string
}

export interface Reply {
  id: string
  originId?: string
  authorId: string
  content: string
  createdAt: string
  updatedAt?: string
  deleted?: boolean
  attachments?: ImageAttachment[]
}

export interface Annotation {
  id: string
  originId?: string
  productId: string
  version: string
  authorId: string
  content: string
  status: AnnotationStatus
  anchor: {
    kind: 'point' | 'region'
    x: number
    y: number
    width?: number
    height?: number
    pageKey?: string
    selector?: string
    elementX?: number
    elementY?: number
    elementWidth?: number
    elementHeight?: number
    regionX?: number
    regionY?: number
    regionWidth?: number
    regionHeight?: number
  }
  createdAt: string
  updatedAt?: string
  deleted?: boolean
  attachments?: ImageAttachment[]
  replies: Reply[]
}

export interface SystemRelease {
  id: string
  version: string
  title: string
  content: string
  releasedAt: string
  authorId: string
  createdAt: string
  updatedAt?: string
}

export interface Product {
  id: string
  name: string
  manager: string
  description: string
  longNote: string
  ownerId: string
  accessCode: string
  accessCodeExpiresAt?: string | null
  codeVersion: number
  state: ProductState
  reviewState: ReviewState
  currentVersion: string
  createdAt: string
  updatedAt: string
  trashedAt?: string
  members: ProductMember[]
  versions: VersionRecord[]
}

export interface AuditLog {
  id: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  targetName: string
  detail: string
  result: 'success' | 'failed'
  createdAt: string
}

export interface BootstrapState {
  currentUser: User
  users: User[]
  products: Product[]
  uploads: UploadRecord[]
  annotations: Annotation[]
  systemReleases: SystemRelease[]
  audit: AuditLog[]
}

export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; fields?: Record<string, string> }
}
