const products = [
 ['bag','Everyday carry','A backpack for the library, the long way home, and everything in between.','Accessories',4800,'photo-1553062407-98eeb64c6a62',['Navy','Black']],
 ['audio','A little quiet','Over-ear headphones for a softer soundtrack to your everyday.','Audio',14900,'photo-1546435770-a3e426bf472b',['Stone','Black']],
 ['chair','The reading chair','A generous seat. A quiet corner. A little room to slow down.','Home',18900,'photo-1598300042247-d088f8ab3a91',['Natural','Walnut']],
 ['camera','Take the long way','A compact camera for the moments you almost walked past.','Objects',24900,'photo-1516035069371-29a1b244cc32',['Black','Silver']],
 ['shoe','Off-duty sneakers','Everyday sneakers with a clean profile and a cushioned sole.','Wear',9500,'photo-1542291026-7eec264c27ff',['Size 8','Size 9','Size 10']],
 ['watch','Time well spent','An everyday watch with a legible dial and understated proportions.','Accessories',7900,'photo-1524805444758-089113d48a6d',['Black','Tan']]
];
export const catalog=products.map(([id,name,description,category,cents,photo,options])=>({id,name,description,category,image:'https://images.unsplash.com/'+photo+'?auto=format&fit=crop&w=900&q=85',variants:options.map((title,i)=>({id:id+'-'+i,title,cents,currency:'CAD',available:!(id==='shoe'&&i===2)}))}));
