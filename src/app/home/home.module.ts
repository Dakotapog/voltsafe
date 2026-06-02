import { IonicModule } from '@ionic/angular';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HomePage } from './home.page';
import { HomePageRoutingModule } from './home-routing.module';
import { AutonomiaGaugeComponent } from './autonomia-gauge.component';

@NgModule({
  imports: [IonicModule, CommonModule, FormsModule, HomePageRoutingModule, AutonomiaGaugeComponent],
  declarations: [HomePage],
})
export class HomePageModule {}
