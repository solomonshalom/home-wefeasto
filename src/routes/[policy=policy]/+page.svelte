<script>
	/* A published CMS policy page (shipping, refunds, grievances, …) in the
	   /terms + /privacy idiom (.wf-legal-*). Data comes
	   from +page.server.js at prerender time; nothing here fetches.
	   /grievances also shows the Grievance Officer and seller details from the
	   store settings when the owner has filled them in. */
	let { data } = $props();

	const description = $derived(`${data.title} — how Wefeasto handles it.`);
	const tel = (p) => 'tel:' + p.replace(/[^\d+]/g, '');
</script>

<svelte:head>
	<title>Wefeasto — {data.title}</title>
	<meta content={description} name="description">
</svelte:head>

<div class="page-wrapper"><div class="section">
    <div class="container max-width-800px">
      <div class="wf-legal-outer wf-policy" data-wf-policy={data.slug}>
        <div class="wf-reveal">
          <div class="text-block-3">Legal</div>
          <div class="divider _24px"></div>
          <h1 class="heading-2">{data.title}</h1>
          <div class="divider _32px mobile-24px"></div>
          <nav class="wf-legal-tabs wf-policy-tabs" aria-label="Store policies">
            <a href="/terms" class="wf-legal-tab">Terms</a>
            <a href="/privacy" class="wf-legal-tab">Privacy</a>
            {#each data.links as l (l.slug)}<a href="/{l.slug}" class="wf-legal-tab{l.slug === data.slug ? ' wf-is-active' : ''}" aria-current={l.slug === data.slug ? 'page' : undefined}>{l.title}</a>{/each}
          </nav>
        </div>

        <div class="divider _42px"></div>

        <div class="wf-reveal">
          <div class="wf-legal wf-policy-body">{@html data.bodyHtml}</div>
        </div>

        {#if data.grievance}
        <div class="divider _42px"></div>
        <div class="wf-reveal">
          <section class="wf-legal-note wf-policy-card" aria-labelledby="wf-grievance-title" data-wf-grievance-officer>
            <h2 id="wf-grievance-title" class="wf-policy-card-title">Grievance Officer</h2>
            <dl class="wf-policy-dl">
              {#if data.grievance.name}<dt>Name</dt><dd>{data.grievance.name}</dd>{/if}
              {#if data.grievance.designation}<dt>Designation</dt><dd>{data.grievance.designation}</dd>{/if}
              {#if data.grievance.email}<dt>Email</dt><dd><a href="mailto:{data.grievance.email}">{data.grievance.email}</a></dd>{/if}
              {#if data.grievance.phone}<dt>Phone</dt><dd><a href={tel(data.grievance.phone)}>{data.grievance.phone}</a></dd>{/if}
            </dl>
          </section>
        </div>
        {/if}

        {#if data.seller}
        <div class="divider _24px"></div>
        <div class="wf-reveal">
          <section class="wf-legal-note wf-policy-card" aria-labelledby="wf-seller-title" data-wf-seller>
            <h2 id="wf-seller-title" class="wf-policy-card-title">Seller details</h2>
            <dl class="wf-policy-dl">
              {#if data.seller.entityName}<dt>Registered name</dt><dd>{data.seller.entityName}</dd>{/if}
              {#if data.seller.address}<dt>Address</dt><dd>{data.seller.address}</dd>{/if}
              {#if data.seller.fssaiLicence}<dt>FSSAI Lic. No.</dt><dd>{data.seller.fssaiLicence}</dd>{/if}
              {#if data.seller.gstin}<dt>GSTIN</dt><dd>{data.seller.gstin}</dd>{/if}
            </dl>
          </section>
        </div>
        {/if}

        <div class="divider _42px"></div>

        <div class="wf-reveal">
          <div class="wf-legal-cta">
            <h2>{data.slug === 'grievances' ? 'Something not right?' : 'Questions?'}</h2>
            <p>{data.whatsapp ? 'Message us on WhatsApp with your order number (it starts with WF-) — we reply Monday to Saturday.' : 'Our team is happy to help, Monday to Saturday.'}</p>
            <div class="wf-legal-cta-actions">
              {#if data.whatsapp}<a href={data.whatsapp} target="_blank" rel="noopener" class="button w-inline-block" data-wf-whatsapp><div>WhatsApp us</div></a>{/if}
              <a href="/#contact" class="button {data.whatsapp ? 'secondary ' : ''}w-inline-block"><div>Contact Us</div></a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div></div>
