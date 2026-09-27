import { CouponRedemptions } from './CouponRedemptions'
import { Coupons } from './Coupons'
import { Counters } from './Counters'
import { Customers } from './Customers'
import { Media } from './Media'
import { MessageLog } from './MessageLog'
import { Orders } from './Orders'
import { Pages } from './Pages'
import { PaymentEvents } from './PaymentEvents'
import { Products } from './Products'
import { Recipes } from './Recipes'
import { Subscribers } from './Subscribers'
import { Users } from './Users'

/** Order here is the admin nav order within each group. */
export const collections = [
  Products,
  Recipes,
  Pages,
  Media,
  Orders,
  Customers,
  Coupons,
  CouponRedemptions,
  PaymentEvents,
  Subscribers,
  MessageLog,
  Counters,
  Users,
]
